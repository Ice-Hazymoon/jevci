/**
 * The plan: which CI jobs a change needs. Rules decide first (forced runs, `full` and `ignore` paths,
 * job paths, comment-only edits, structural changes); Jev may then drop a job the rules would run, file
 * by file, when it is confident the change cannot make that job fail. Anything that goes wrong on the way
 * keeps the jobs the rules chose.
 */
import type { ResolvedJevciConfig, ResolvedJevOptions } from './config.js';
import type { ChangedFile, TChangeStatus } from './git.js';
import type { JevciJudge, JudgeCase } from './judge.js';
import { evidenceFrom, removedTexts } from './evidence.js';
import { changedFiles, commitMessages, fileDiff, filesContainingEach, JevciRangeError, MAX_TEXT_BYTES, prefetchBlobs, resolveRange, textsAt } from './git.js';
import { matchesAny } from './glob.js';
import { judgeCases, judgeTokens } from './judge.js';
import { normalize } from './normalize.js';
import { removedExports } from './surface.js';

/** Bumped when the JSON shape of `Plan` changes incompatibly. */
export const PLAN_SCHEMA_VERSION = 1;

export type TPlanLevel = 'none' | 'partial' | 'full';

/**
 * - `ignored`: matches `ignore` and was added or edited.
 * - `full`: matches `full`; every job runs.
 * - `unclaimed`: no job's paths include it.
 * - `noop`: only comments or formatting changed.
 * - `structural`: added, deleted, renamed, copied, binary, a type change, or an edit that removes or renames an export.
 * - `substantive`: edited text whose behaviour may differ.
 */
export type TFileVerdict = 'ignored' | 'full' | 'unclaimed' | 'noop' | 'structural' | 'substantive';

export interface FilePlan {
    path: string;
    oldPath?: string;
    status: TChangeStatus;
    verdict: TFileVerdict;
    /** Jobs whose paths include the file. */
    jobs: string[];
    /** Jobs this file makes run. */
    runs: string[];
    /** P(the change can make the job fail), per job the judge was asked about. */
    jev?: Record<string, number>;
    /** Why the judge was not asked about this file. */
    note?: string;
    /** Jobs outside whose paths this file lies that it runs through a trigger. */
    triggered?: string[];
}

export interface JobPlan {
    run: boolean;
    /** The first reason the job runs, or why it does not. */
    reason: string;
}

export interface Plan {
    schemaVersion: typeof PLAN_SCHEMA_VERSION;
    level: TPlanLevel;
    /** The merge base and head that were diffed, when the range resolved. */
    base?: string;
    head?: string;
    jobs: Record<string, JobPlan>;
    files: FilePlan[];
    /** One line on how the plan was decided. */
    reason: string;
    /** A safety fallback replaced a narrower plan (the judge failed, timed out, or a limit was hit). */
    fallback?: string;
    /** The judge's name and usage, when it was asked. */
    judge?: { name?: string; asked?: number; requests?: number; inputTokens?: number; cacheHits?: number };
    /** Planned and full job minutes, from each job's `minutes`. */
    minutes: { planned: number; full: number };
}

export interface PlanInput {
    base: string;
    head: string;
    /** CI event name (`push`, `pull_request`, `schedule`, …). */
    event?: string;
    /** Pull request labels. */
    labels?: readonly string[];
    /** Pull request body. */
    body?: string;
    /** The judge; without one the rules alone decide. */
    judge?: JevciJudge;
}

interface Range { base: string; head: string }

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function minutesOf(config: ResolvedJevciConfig, run: (id: string) => boolean): number {
    return Object.entries(config.jobs).reduce((sum, [id, job]) => sum + (run(id) ? job.minutes ?? 0 : 0), 0);
}

/** Every job runs, for one reason. */
export function fullPlan(config: ResolvedJevciConfig, reason: string, extra: Partial<Pick<Plan, 'base' | 'head' | 'files' | 'fallback'>> = {}): Plan {
    const jobs = Object.fromEntries(Object.keys(config.jobs).map(id => [id, { run: true, reason }]));
    const minutes = minutesOf(config, () => true);
    return { schemaVersion: PLAN_SCHEMA_VERSION, level: 'full', ...extra, jobs, files: extra.files ?? [], reason, minutes: { planned: minutes, full: minutes } };
}

function forcedReason(config: ResolvedJevciConfig, input: PlanInput, messages: readonly string[]): string | undefined {
    if (input.event && config.force.events.includes(input.event)) { return `event "${input.event}" runs every job`; }
    const label = input.labels?.find(name => config.force.labels.includes(name));
    if (label) { return `label "${label}"`; }
    const marker = config.force.markers.find(text => input.body?.includes(text) || messages.some(message => message.includes(text)));
    return marker ? `"${marker}" in a commit message or the pull request body` : undefined;
}

interface Classified extends FilePlan {
    /** Jobs the judge may drop for this file. */
    candidates: string[];
}

function jobsFor(config: ResolvedJevciConfig, paths: readonly string[]): string[] {
    return Object.entries(config.jobs).filter(([, job]) => paths.some(path => matchesAny(job.paths, path) && !matchesAny(job.exclude, path))).map(([id]) => id);
}

/** A plain edit: a no-op when both sides normalize alike, else real, split into jobs that run outright and jobs the judge may drop. */
function classifyEdit(config: ResolvedJevciConfig, entry: Pick<FilePlan, 'path' | 'oldPath' | 'status'>, jobs: string[], before: string, after: string): Classified {
    const normalized = config.noop ? normalize(entry.path, before, config.noop) : undefined;
    if (config.noop && normalized !== undefined && normalized === normalize(entry.path, after, config.noop)) {
        return { ...entry, verdict: 'noop', jobs, runs: jobs.filter(id => config.jobs[id]!.formatting), candidates: [] };
    }
    const removed = removedExports(entry.path, before.split('\n'), after.split('\n'));
    if (removed.length) { return { ...entry, verdict: 'structural', jobs, runs: [...jobs], candidates: [], note: `removes or renames exports: ${removed.join(', ')}` }; }
    const direct = jobs.filter(id => !config.jobs[id]!.downgrade || matchesAny(config.jobs[id]!.owns, entry.path));
    return { ...entry, verdict: 'substantive', jobs, runs: direct, candidates: jobs.filter(id => !direct.includes(id)) };
}

/** Lines on one side and not the other: what an edit added or removed, order ignored. */
function changedLines(before: string | undefined, after: string | undefined): string[] {
    const old = new Set((before ?? '').split('\n'));
    const next = new Set((after ?? '').split('\n'));
    return [...[...old].filter(line => !next.has(line)), ...[...next].filter(line => !old.has(line))];
}

/** The trigger-matching side texts of a change; `undefined` when a side that exists could not be read. */
function triggerSides(range: Range, file: ChangedFile, texts: ReadonlyMap<string, string | undefined>): [string | undefined, string | undefined] | undefined {
    const before = file.status === 'added' ? '' : texts.get(`${range.base}:${file.oldPath ?? file.path}`);
    const after = file.status === 'deleted' ? '' : texts.get(`${range.head}:${file.path}`);
    return file.binary || before === undefined || after === undefined ? undefined : [before, after];
}

/** Jobs a trigger runs for this file: its files match and a changed line matches its pattern (an unreadable change always matches). */
function triggeredJobs(config: ResolvedJevciConfig, range: Range, file: ChangedFile, texts: ReadonlyMap<string, string | undefined>, skip: readonly string[]): string[] {
    const paths = file.oldPath ? [file.path, file.oldPath] : [file.path];
    const hit = (trigger: ResolvedJevciConfig['jobs'][string]['triggers'][number]): boolean => {
        if (!paths.some(path => matchesAny(trigger.files, path))) { return false; }
        if (!trigger.pattern) { return true; }
        const sides = triggerSides(range, file, texts);
        return !sides || changedLines(...sides).some(line => trigger.pattern!.test(line));
    };
    return Object.entries(config.jobs).filter(([id, job]) => !skip.includes(id) && job.triggers.some(hit)).map(([id]) => id);
}

function classify(config: ResolvedJevciConfig, range: Range, file: ChangedFile, texts: ReadonlyMap<string, string | undefined>): Classified {
    const classified = classifyPaths(config, range, file, texts);
    const triggered = triggeredJobs(config, range, file, texts, classified.runs);
    if (!triggered.length) { return classified; }
    return {
        ...classified,
        jobs: [...new Set([...classified.jobs, ...triggered])],
        runs: [...classified.runs, ...triggered],
        candidates: classified.candidates.filter(id => !triggered.includes(id)),
        triggered,
    };
}

function classifyPaths(config: ResolvedJevciConfig, range: Range, file: ChangedFile, texts: ReadonlyMap<string, string | undefined>): Classified {
    const paths = file.oldPath ? [file.path, file.oldPath] : [file.path];
    const entry = { path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), status: file.status };
    const moved = file.status === 'deleted' || file.status === 'renamed';
    if (!moved && paths.every(path => matchesAny(config.ignore, path))) { return { ...entry, verdict: 'ignored', jobs: [], runs: [], candidates: [] }; }
    const ids = Object.keys(config.jobs);
    if (paths.some(path => matchesAny(config.full, path))) { return { ...entry, verdict: 'full', jobs: ids, runs: ids, candidates: [] }; }
    const jobs = jobsFor(config, paths);
    if (jobs.length === 0) { return { ...entry, verdict: 'unclaimed', jobs, runs: [], candidates: [] }; }
    const before = texts.get(`${range.base}:${file.path}`);
    const after = texts.get(`${range.head}:${file.path}`);
    if (file.binary || file.status !== 'modified') { return { ...entry, verdict: 'structural', jobs, runs: [...jobs], candidates: [] }; }
    if (before === undefined || after === undefined) { return { ...entry, verdict: 'structural', jobs, runs: [...jobs], candidates: [], note: `is not compared as text (over ${MAX_TEXT_BYTES / (1 << 20)} MiB, or unreadable)` }; }
    return classifyEdit(config, entry, jobs, before, after);
}

function withTimeout<T>(promise: Promise<T>, seconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${seconds}s`)), seconds * 1000);
        timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Every candidate job runs for these files, for one reason. */
function keepCandidates(files: readonly Classified[], note: string): string {
    for (const file of files) {
        file.runs.push(...file.candidates.filter(id => !file.runs.includes(id)));
        file.note = note;
    }
    return note;
}

/** One judge case per file; a file whose diff is over the limit keeps its jobs instead. */
async function judgeInputs(config: ResolvedJevciConfig, jev: ResolvedJevOptions, range: Range, pending: readonly Classified[]): Promise<Array<{ file: Classified; input: JudgeCase }>> {
    const judged: Array<{ file: Classified; diff: string }> = [];
    for (const file of pending) {
        const diff = fileDiff(config.root, range.base, range.head, file);
        if (diff.length > jev.maxDiffChars) {
            keepCandidates([file], `diff of ${diff.length} characters, over jev.maxDiffChars (${jev.maxDiffChars})`);
            continue;
        }
        judged.push({ file, diff });
    }
    // Every judged diff's removed text, deduplicated, searched in parallel.
    const texts = jev.testFiles.length ? judged.flatMap(({ diff }) => removedTexts(diff)) : [];
    const hits = await filesContainingEach(config.root, range.head, texts, jev.testFiles, jev.concurrency);
    return judged.map(({ file, diff }) => {
        const jobs = Object.fromEntries(file.candidates.map(id => [id, config.jobs[id]!.checks]));
        return { file, input: { file: file.path, diff, evidence: evidenceFrom(diff, hits), jobs, context: jev.context } };
    });
}

/** Records each answer; a job whose P reaches its threshold runs. A missing or malformed answer counts as "can fail". */
function applyAnswer(config: ResolvedJevciConfig, jev: ResolvedJevOptions, file: Classified, answer: Record<string, number>): void {
    file.jev = {};
    for (const id of file.candidates) {
        const probability = answer[id];
        const p = typeof probability === 'number' && Number.isFinite(probability) ? probability : 1;
        file.jev[id] = p;
        if (p >= (config.jobs[id]!.threshold ?? jev.threshold)) { file.runs.push(id); }
    }
}

/** Asks the judge about every file with candidate jobs; a confident "cannot fail" drops the job for that file. Returns a fallback note. */
async function applyJudge(config: ResolvedJevciConfig, jev: ResolvedJevOptions, judge: JevciJudge, range: Range, files: readonly Classified[]): Promise<string | undefined> {
    const pending = files.filter(file => file.candidates.length > 0);
    if (pending.length === 0) { return undefined; }
    if (pending.length > jev.maxFiles) { return keepCandidates(pending, `${pending.length} files to judge, over jev.maxFiles (${jev.maxFiles})`); }
    prefetchBlobs(config.root, range.head, jev.testFiles);
    const cases = await judgeInputs(config, jev, range, pending);
    const tokens = cases.reduce((sum, { input }) => sum + judgeTokens(input), 0);
    if (tokens > jev.maxTokens) { return keepCandidates(pending, `about ${tokens} tokens to judge, over jev.maxTokens (${jev.maxTokens})`); }
    try {
        const answers = await withTimeout(judgeCases(judge, cases.map(({ input }) => input)), jev.timeoutSeconds);
        cases.forEach(({ file }, index) => applyAnswer(config, jev, file, answers[index] ?? {}));
        return undefined;
    } catch (err: unknown) {
        return keepCandidates(pending, `judge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function runReason(config: ResolvedJevciConfig, id: string, runner: Classified): string {
    if (runner.triggered?.includes(id)) { return `${runner.path} matches one of the job's triggers`; }
    const probability = runner.jev?.[id];
    if (runner.verdict === 'structural') { return runner.note ? `${runner.path} ${runner.note}` : `${runner.path} was ${runner.status}`; }
    if (runner.verdict === 'noop') { return `${runner.path} changed only comments or formatting, which the job reads`; }
    if (probability !== undefined) { return `${runner.path} can make it fail (P=${probability.toFixed(2)})`; }
    if (runner.note && runner.candidates.includes(id)) { return `${runner.path}: ${runner.note}`; }
    if (matchesAny(config.jobs[id]!.owns, runner.path)) { return `${runner.path} is owned by the job`; }
    return `${runner.path} changed and the job is never downgraded`;
}

function skipReason(id: string, files: readonly Classified[]): string {
    const asked = files.filter(file => file.jev?.[id] !== undefined);
    if (asked.length) {
        const highest = Math.max(...asked.map(file => file.jev![id]!));
        return `no change can make it fail (${plural(asked.length, 'file')} judged, highest P=${highest.toFixed(2)})`;
    }
    return files.some(file => file.jobs.includes(id)) ? 'its files changed only comments or formatting' : 'no changed file is in its paths';
}

function jobPlans(config: ResolvedJevciConfig, files: readonly Classified[]): Record<string, JobPlan> {
    const real = files.some(file => file.verdict === 'unclaimed' || file.verdict === 'structural' || file.verdict === 'substantive');
    const jobs: Record<string, JobPlan> = {};
    for (const id of Object.keys(config.jobs)) {
        const runner = files.find(file => file.runs.includes(id));
        if (runner) {
            jobs[id] = { run: true, reason: runReason(config, id, runner) };
        } else {
            jobs[id] = real && config.minimumJobs.includes(id) ? { run: true, reason: 'minimum job: runs on any real change' } : { run: false, reason: skipReason(id, files) };
        }
    }
    return jobs;
}

function summary(files: readonly FilePlan[]): string {
    if (files.length === 0) { return 'no file changed'; }
    const counts = new Map<TFileVerdict, number>();
    for (const file of files) { counts.set(file.verdict, (counts.get(file.verdict) ?? 0) + 1); }
    return `${plural(files.length, 'changed file')}: ${[...counts].map(([verdict, count]) => `${count} ${verdict}`).join(', ')}`;
}

function levelOf(jobs: Record<string, JobPlan>): TPlanLevel {
    const running = Object.values(jobs).filter(job => job.run).length;
    if (running === 0) { return 'none'; }
    return running === Object.keys(jobs).length ? 'full' : 'partial';
}

/** The merge-base range, or the reason it cannot be diffed. */
function planRange(config: ResolvedJevciConfig, input: PlanInput): Range | { error: string } {
    try {
        return resolveRange(config.root, input.base, input.head);
    } catch (err: unknown) {
        if (err instanceof JevciRangeError) { return { error: err.message }; }
        throw err;
    }
}

/** Every changed file, classified; both sides of each plain edit are read in one git call. */
function classifyAll(config: ResolvedJevciConfig, range: Range): Classified[] {
    const changed = changedFiles(config.root, range.base, range.head);
    const edited = changed.filter(file => file.status === 'modified' && !file.binary);
    const triggerFiles = Object.values(config.jobs).flatMap(job => job.triggers.flatMap(trigger => trigger.files));
    const watched = triggerFiles.length ? changed.filter(file => !file.binary && [file.path, file.oldPath].some(path => path && matchesAny(triggerFiles, path))) : [];
    const specs = new Set(edited.flatMap(file => [`${range.base}:${file.path}`, `${range.head}:${file.path}`]));
    for (const file of watched) {
        if (file.status !== 'added') { specs.add(`${range.base}:${file.oldPath ?? file.path}`); }
        if (file.status !== 'deleted') { specs.add(`${range.head}:${file.path}`); }
    }
    const texts = textsAt(config.root, [...specs]);
    return changed.map(file => classify(config, range, file, texts));
}

const strip = ({ candidates: _candidates, ...file }: Classified): FilePlan => file;

/** Decides the jobs for `input.base`..`input.head`. A bad range or a failing judge yields a safe plan, never an error. */
export async function createPlan(config: ResolvedJevciConfig, input: PlanInput): Promise<Plan> {
    const early = forcedReason(config, input, []);
    if (early) { return fullPlan(config, early); }
    const range = planRange(config, input);
    if ('error' in range) { return fullPlan(config, 'the commit range could not be diffed', { fallback: range.error }); }
    const marker = forcedReason(config, input, commitMessages(config.root, range.base, range.head));
    if (marker) { return fullPlan(config, marker, range); }
    const files = classifyAll(config, range);
    const forcing = files.find(file => file.verdict === 'full');
    if (forcing) { return fullPlan(config, `${forcing.path} matches "full"`, { ...range, files: files.map(strip) }); }
    const judge = config.jev ? input.judge : undefined;
    const fallback = judge && config.jev ? await applyJudge(config, config.jev, judge, range, files) : undefined;
    if (!judge) { keepCandidates(files.filter(file => file.candidates.length > 0), 'no judge'); }
    const jobs = jobPlans(config, files);
    return {
        schemaVersion: PLAN_SCHEMA_VERSION,
        level: levelOf(jobs),
        ...range,
        jobs,
        files: files.map(strip),
        reason: summary(files),
        ...(fallback ? { fallback } : {}),
        ...(judge && (fallback || files.some(file => file.jev)) ? { judge: { name: judge.name, ...judge.stats } } : {}),
        minutes: { planned: minutesOf(config, id => jobs[id]!.run), full: minutesOf(config, () => true) },
    };
}
