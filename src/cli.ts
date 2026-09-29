/**
 * The `jevci` command line. Every command is a thin layer over the programmatic API.
 */
/* eslint-disable no-console -- a CLI's output is console output */
import type { ResolvedJevciConfig } from './config.js';
import type { CiContext } from './context.js';
import type { Evidence } from './evidence.js';
import type { JevciJudge, JudgeCase } from './judge.js';
import type { Plan, PlanInput, TPlanLevel } from './plan.js';
import type { TReportFormat } from './report.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findConfigFile, JevciConfigError, loadConfig } from './config.js';
import { detectContext } from './context.js';
import { git } from './git.js';
import { matchesAny } from './glob.js';
import { createJevJudge, judgeCases } from './judge.js';
import { createPlan, fullPlan } from './plan.js';
import { formatPlan, REPORT_FORMATS, writeGithub } from './report.js';
import { removedExports } from './surface.js';
import { checkWorkflow, draftConfig, findWorkflow, readWorkflow, workflowSnippet } from './workflow.js';

interface OptionSpec { name: string; value?: string; help: string }
interface CommandSpec { usage: string; summary: string; details?: string; options: readonly OptionSpec[] }

const CONFIG: OptionSpec = { name: 'config', value: 'path', help: 'jevci.config.{ts,mts,js,mjs} (default: the nearest one)' };

const COMMANDS: Record<string, CommandSpec> = {
    plan: {
        usage: 'jevci plan [options]',
        summary: 'Decide which CI jobs a commit range needs.',
        details: 'In GitHub Actions and GitLab CI the range, event, labels and description come from the environment; flags override them. Elsewhere the range defaults to HEAD^..HEAD.\nExit code 0 whatever the plan; if jevci itself fails, the plan runs every job.',
        options: [
            { name: 'base', value: 'rev', help: 'diff from the merge base of <rev> and head' },
            { name: 'head', value: 'rev', help: 'the commit to plan for' },
            { name: 'event', value: 'name', help: 'CI event (schedule, workflow_dispatch and web run every job)' },
            { name: 'labels', value: 'a,b', help: 'pull request labels' },
            { name: 'format', value: 'name', help: `${REPORT_FORMATS.join(', ')} (default: github in GitHub Actions, else text)` },
            { name: 'output', value: 'file', help: 'also write the plan as JSON to <file>' },
            { name: 'no-jev', help: 'rules only; never ask Jev' },
            CONFIG,
        ],
    },
    check: {
        usage: 'jevci check [options]',
        summary: 'Check that the workflow gates every configured job on the plan, and that no job is missing from either side.',
        options: [
            { name: 'workflow', value: 'path', help: 'GitHub Actions workflow (default: the one that runs `jevci plan`, else ci.yml)' },
            { name: 'plan-job', value: 'id', help: 'the job that runs `jevci plan` (default: detected)' },
            CONFIG,
        ],
    },
    init: {
        usage: 'jevci init [options]',
        summary: 'Write a starting jevci.config.ts with one entry per workflow job, and print the workflow wiring.',
        options: [{ name: 'workflow', value: 'path', help: 'GitHub Actions workflow to read job ids from' }],
    },
    replay: {
        usage: 'jevci replay [options]',
        summary: 'Plan each recent commit on the first-parent history and total the job minutes it would save.',
        options: [
            { name: 'last', value: 'n', help: 'commits to replay (default 50)' },
            { name: 'jev', help: 'also ask Jev (costs tokens; answers are cached)' },
            { name: 'max-tokens', value: 'n', help: 'stop asking Jev after this many input tokens (default 300000)' },
            { name: 'format', value: 'name', help: 'text or json' },
            CONFIG,
        ],
    },
    eval: {
        usage: 'jevci eval --cases <file.jsonl> [options]',
        summary: 'Score the plan on labelled cases: missed and dropped jobs per threshold and per job.',
        details: 'Each line: {"id", "file", "diff", "evidence"?, "expect": {"<job>": true if the change can make it fail}}. Jobs are routed as a plan would: dropped by paths, kept by owns or downgrade: false, or asked. Exit code 1 when a job that can fail would be dropped at the configured thresholds.',
        options: [
            { name: 'cases', value: 'file', help: 'labelled cases (JSONL)' },
            { name: 'answers', value: 'file', help: 'reuse answers from <file> when it exists, else ask and save them there' },
            { name: 'threshold', value: 'p', help: 'one threshold for every job instead of the configured ones' },
            CONFIG,
        ],
    },
};

const OPTION_NAMES = [...new Set(Object.values(COMMANDS).flatMap(command => command.options.map(option => option.name)))];

function usage(command?: string): string {
    const spec = command ? COMMANDS[command] : undefined;
    if (!spec) {
        const width = Math.max(...Object.keys(COMMANDS).map(name => name.length));
        return ['Usage: jevci <command> [options]', '', 'Commands:', ...Object.entries(COMMANDS).map(([name, cmd]) => `  ${name.padEnd(width)}  ${cmd.summary}`), '', 'Run `jevci <command> --help` for its options, `jevci --version` for the version.'].join('\n');
    }
    const flags = spec.options.map(option => [`--${option.name}${option.value ? ` <${option.value}>` : ''}`, option.help] as const);
    const width = Math.max(...flags.map(([flag]) => flag.length));
    return [`Usage: ${spec.usage}`, '', spec.summary, ...(spec.details ? ['', spec.details] : []), '', 'Options:', ...flags.map(([flag, help]) => `  ${flag.padEnd(width)}  ${help}`)].join('\n');
}

type Options = Partial<Record<string, string | boolean>>;

function parse(argv: readonly string[]): { command?: string; options: Options } {
    const { values, positionals } = parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: {
            ...Object.fromEntries(OPTION_NAMES.map((name) => {
                const takesValue = Object.values(COMMANDS).some(command => command.options.some(option => option.name === name && option.value));
                return [name, { type: takesValue ? 'string' as const : 'boolean' as const }];
            })),
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean', short: 'v' },
        },
    });
    return { command: positionals[0], options: values };
}

const text = (options: Options, name: string): string | undefined => (typeof options[name] === 'string' ? options[name] : undefined);

function positiveNumber(options: Options, name: string, fallback: number): number {
    const raw = text(options, name);
    if (raw === undefined) { return fallback; }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) { throw new JevciConfigError(`--${name} must be a positive number, got "${raw}".`); }
    return value;
}

/** The built-in Jev judge, or why there is none. */
function tryJudge(config: ResolvedJevciConfig): { judge?: JevciJudge; unavailable?: string } {
    if (!config.jev) { return { unavailable: 'jev is off in the config' }; }
    try {
        return { judge: createJevJudge(config.jev) };
    } catch (err: unknown) {
        return { unavailable: err instanceof Error ? err.message : String(err) };
    }
}

function planInput(options: Options, context: CiContext, judge: JevciJudge | undefined): PlanInput {
    const labels = text(options, 'labels')?.split(',').map(label => label.trim()).filter(Boolean);
    return {
        base: text(options, 'base') ?? context.base ?? 'HEAD^',
        head: text(options, 'head') ?? context.head ?? 'HEAD',
        event: text(options, 'event') ?? context.event,
        labels: labels ?? context.labels,
        body: context.body,
        judge,
    };
}

/** The plan, or one that runs every job when jevci itself fails: CI must neither go red nor skip work because of it. */
async function safePlan(config: ResolvedJevciConfig, options: Options, context: CiContext): Promise<Plan> {
    try {
        const { judge, unavailable } = options['no-jev'] ? {} : tryJudge(config);
        const result = await createPlan(config, planInput(options, context, judge));
        const unjudged = unavailable && config.jev && result.files.some(file => file.note === 'no judge');
        return unjudged ? { ...result, fallback: result.fallback ?? `Jev unavailable: ${unavailable}` } : result;
    } catch (err: unknown) {
        const result = fullPlan(config, 'jevci failed', { fallback: err instanceof Error ? err.message : String(err) });
        if (context.provider === 'github') { console.log(`::warning title=jevci::${result.fallback}`); }
        return result;
    }
}

async function plan(options: Options): Promise<number> {
    const context = detectContext();
    const format = (text(options, 'format') ?? (context.provider === 'github' ? 'github' : 'text')) as TReportFormat;
    if (!REPORT_FORMATS.includes(format)) { throw new JevciConfigError(`--format must be one of ${REPORT_FORMATS.join(', ')}, got "${format}".`); }
    const result = await safePlan(await loadConfig(text(options, 'config')), options, context);
    process.stdout.write(formatPlan(result, format));
    if (format === 'github') { writeGithub(result); }
    const output = text(options, 'output');
    if (output) { writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`); }
    return 0;
}

async function check(options: Options): Promise<number> {
    const config = await loadConfig(text(options, 'config'));
    const workflow = text(options, 'workflow') ? resolve(text(options, 'workflow')!) : findWorkflow(config.root);
    if (!workflow) { throw new JevciConfigError('No workflow found under .github/workflows; pass --workflow <path>.'); }
    const findings = checkWorkflow(config, readWorkflow(workflow), text(options, 'plan-job'));
    const where = relative(process.cwd(), workflow) || workflow;
    for (const finding of findings) { console.log(`${finding.severity}: ${where}: ${finding.job ? `job "${finding.job}" ` : ''}${finding.message}`); }
    const errors = findings.filter(finding => finding.severity === 'error').length;
    console.log(errors || findings.length ? `\n${errors} error(s), ${findings.length - errors} warning(s)` : `${where} gates every configured job on the plan.`);
    return errors ? 1 : 0;
}

function init(options: Options): number {
    const cwd = process.cwd();
    const existing = findConfigFile(cwd);
    if (existing && resolve(existing, '..') === cwd) { throw new JevciConfigError(`${relative(cwd, existing)} already exists; not overwriting it.`); }
    const workflow = text(options, 'workflow') ? resolve(text(options, 'workflow')!) : findWorkflow(cwd);
    const jobs = workflow ? readWorkflow(workflow).filter(job => !job.runsPlan) : [];
    writeFileSync(resolve(cwd, 'jevci.config.ts'), draftConfig(jobs.map(job => job.id)));
    console.log(`Wrote jevci.config.ts${workflow ? ` with the ${jobs.length} job${jobs.length === 1 ? '' : 's'} of ${relative(cwd, workflow)}` : ' with example jobs'}.`);
    console.log('\nNext:\n  1. Describe each job in `checks` (what it verifies and what it cannot see) and narrow its `paths`.');
    console.log('  2. Add a plan job and gate each job on it:\n');
    console.log(workflowSnippet('plan', jobs[0]?.id ?? 'test').replace(/^/gm, '     '));
    console.log('\n  3. Run `jevci check`, then `jevci replay` to see what it would have saved.');
    return 0;
}

interface ReplayRow { commit: string; subject: string; plan: Plan }

interface ReplayTotals { levels: Record<TPlanLevel, number>; skipped: Record<string, number>; planned: number; full: number }

async function replayRows(config: ResolvedJevciConfig, last: number, judge: JevciJudge | undefined, maxTokens: number): Promise<ReplayRow[]> {
    const rows: ReplayRow[] = [];
    for (const commit of git(config.root, ['rev-list', '--first-parent', `--max-count=${last}`, 'HEAD']).split('\n').filter(Boolean)) {
        const parent = git(config.root, ['rev-list', '--parents', '-n', '1', commit]).trim().split(' ')[1];
        if (!parent) { continue; }
        const withinBudget = (judge?.stats?.inputTokens ?? 0) < maxTokens ? judge : undefined;
        const result = await createPlan(config, { base: parent, head: commit, event: 'push', judge: withinBudget });
        rows.push({ commit, subject: git(config.root, ['log', '-1', '--format=%s', commit]).trim(), plan: result });
    }
    return rows;
}

function tally(config: ResolvedJevciConfig, rows: readonly ReplayRow[]): ReplayTotals {
    const totals: ReplayTotals = { levels: { none: 0, partial: 0, full: 0 }, skipped: Object.fromEntries(Object.keys(config.jobs).map(id => [id, 0])), planned: 0, full: 0 };
    for (const { plan: result } of rows) {
        totals.levels[result.level]++;
        totals.planned += result.minutes.planned;
        totals.full += result.minutes.full;
        const skips = Object.entries(result.jobs).filter(([, job]) => !job.run).map(([id]) => id);
        for (const id of skips) { totals.skipped[id] = (totals.skipped[id] ?? 0) + 1; }
    }
    return totals;
}

function replayLine({ commit, subject, plan: result }: ReplayRow, withMinutes: boolean): string {
    const skips = Object.entries(result.jobs).filter(([, job]) => !job.run).map(([id]) => id);
    const minutes = withMinutes ? `${result.minutes.planned.toFixed(1).padStart(5)}m  ` : '';
    const skipped = result.level === 'partial' ? `  [skip ${skips.join(', ')}]` : '';
    return `${commit.slice(0, 9)}  ${result.level.padEnd(7)}  ${minutes}${subject.slice(0, 72)}${skipped}`;
}

function judgeUsage(judge: JevciJudge): string {
    const stats = judge.stats;
    return `judge: ${judge.name ?? 'custom'}${stats ? ` (${stats.asked} questions, ${stats.inputTokens} input tokens, ${stats.cacheHits} cached)` : ''}`;
}

async function replay(options: Options): Promise<number> {
    const config = await loadConfig(text(options, 'config'));
    const { judge, unavailable } = options.jev ? tryJudge(config) : {};
    if (options.jev && !judge) { throw new JevciConfigError(`--jev needs a Jev provider: ${unavailable}`); }
    const rows = await replayRows(config, positiveNumber(options, 'last', 50), judge, positiveNumber(options, 'max-tokens', 300_000));
    const totals = tally(config, rows);
    if (text(options, 'format') === 'json') {
        console.log(JSON.stringify({ commits: rows.length, ...totals, judge: judge?.stats, rows }, null, 2));
        return 0;
    }
    console.log(rows.map(row => replayLine(row, totals.full > 0)).join('\n'));
    console.log(`\n${rows.length} commits: ${totals.levels.none} skip everything, ${totals.levels.partial} partial, ${totals.levels.full} full`);
    if (totals.full) { console.log(`job minutes: ${totals.planned.toFixed(0)} of ${totals.full.toFixed(0)} (${(100 - totals.planned / totals.full * 100).toFixed(0)}% saved)`); }
    console.log(`times skipped: ${Object.entries(totals.skipped).map(([id, count]) => `${id} ${count}`).join(', ')}`);
    if (judge) { console.log(judgeUsage(judge)); }
    return 0;
}

interface EvalCase { id: string; file: string; diff: string; evidence?: Evidence; expect: Record<string, boolean> }

type TAnswers = Record<string, Record<string, number>>;

const THRESHOLDS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6];

function parseCase(line: string, where: string, config: ResolvedJevciConfig): EvalCase {
    let item: EvalCase;
    try {
        item = JSON.parse(line) as EvalCase;
    } catch {
        throw new JevciConfigError(`${where}: not valid JSON.`);
    }
    const complete = typeof item.id === 'string' && typeof item.file === 'string' && typeof item.diff === 'string' && typeof item.expect === 'object' && item.expect !== null;
    if (!complete) { throw new JevciConfigError(`${where}: needs "id", "file", "diff" and "expect".`); }
    const unknown = Object.keys(item.expect).filter(id => !(id in config.jobs));
    if (unknown.length) { throw new JevciConfigError(`${where}: unknown job ${unknown.join(', ')}.`); }
    return item;
}

function readCases(path: string, config: ResolvedJevciConfig): EvalCase[] {
    return readFileSync(path, 'utf8').split('\n').flatMap((line, index) => (line.trim() ? [parseCase(line, `${path}:${index + 1}`, config)] : []));
}

/** How the plan treats one job for a case: dropped by its paths, kept by a rule (removed exports, `owns`, `downgrade: false`), or asked. */
type TRoute = 'paths' | 'rule' | 'asked';

function route(config: ResolvedJevciConfig, item: EvalCase, id: string): TRoute {
    const job = config.jobs[id]!;
    if (!matchesAny(job.paths, item.file) || matchesAny(job.exclude, item.file)) { return 'paths'; }
    const lines = (sign: string): string[] => item.diff.split('\n').filter(line => line.startsWith(sign)).map(line => line.slice(1));
    const surface = removedExports(item.file, lines('-'), lines('+')).length > 0;
    return surface || !job.downgrade || matchesAny(job.owns, item.file) ? 'rule' : 'asked';
}

/** Recorded answers when `answersPath` exists; otherwise the judge's for the asked jobs, saved there when given. */
async function collectAnswers(config: ResolvedJevciConfig, cases: readonly EvalCase[], answersPath: string | undefined): Promise<TAnswers> {
    if (answersPath && existsSync(answersPath)) { return JSON.parse(readFileSync(answersPath, 'utf8')) as TAnswers; }
    const { judge, unavailable } = tryJudge(config);
    if (!judge) { throw new JevciConfigError(`eval needs a Jev provider: ${unavailable}`); }
    const asked = cases.map(item => ({ item, jobs: Object.keys(item.expect).filter(id => route(config, item, id) === 'asked') })).filter(({ jobs }) => jobs.length > 0);
    const inputs: JudgeCase[] = asked.map(({ item, jobs }) => ({
        file: item.file,
        diff: item.diff,
        evidence: item.evidence ?? { testsContainingRemovedText: [], removedTextNotInTests: [] },
        jobs: Object.fromEntries(jobs.map(id => [id, config.jobs[id]!.checks])),
        context: config.jev ? config.jev.context : undefined,
    }));
    const results = await judgeCases(judge, inputs);
    const answers = Object.fromEntries(asked.map(({ item }, index) => [item.id, results[index] ?? {}]));
    if (answersPath) { writeFileSync(answersPath, `${JSON.stringify(answers, null, 2)}\n`); }
    console.log(judgeUsage(judge));
    return answers;
}

interface EvalPair { id: string; job: string; fails: boolean; route: TRoute; p: number }

/** Every judgement as the plan would make it: rule routes count as P=0 (dropped by paths) or P=1 (kept). */
function evalPairs(config: ResolvedJevciConfig, cases: readonly EvalCase[], answers: TAnswers): EvalPair[] {
    return cases.flatMap(item => Object.entries(item.expect).map(([job, fails]) => {
        const how = route(config, item, job);
        const p = how === 'asked' ? answers[item.id]?.[job] ?? 1 : Number(how === 'rule');
        return { id: item.id, job, fails, route: how, p };
    }));
}

/** Missed and dropped judgements per threshold, one column per job the judge was asked about. */
function printSweep(pairs: readonly EvalPair[]): void {
    const jobs = [...new Set(pairs.filter(pair => pair.route === 'asked').map(pair => pair.job))];
    const cell = (subset: readonly EvalPair[], threshold: number): string => {
        const missed = subset.filter(pair => pair.fails && pair.p < threshold).length;
        const dropped = subset.filter(pair => !pair.fails && pair.p < threshold).length;
        return `${missed}/${dropped} of ${subset.filter(pair => !pair.fails).length}`;
    };
    const columns = [...jobs, 'all'];
    const width = Math.max(14, ...columns.map(column => column.length + 2));
    console.log(`threshold  ${columns.map(column => column.padEnd(width)).join('')}   (missed/dropped of cannot-fail)`);
    for (const threshold of THRESHOLDS) {
        const cells = columns.map(column => cell(column === 'all' ? pairs : pairs.filter(pair => pair.job === column), threshold).padEnd(width));
        console.log(`${threshold.toFixed(2).padStart(9)}  ${cells.join('')}`);
    }
}

async function evaluate(options: Options): Promise<number> {
    const config = await loadConfig(text(options, 'config'));
    const casesPath = text(options, 'cases');
    if (!casesPath) { throw new JevciConfigError('eval needs --cases <file.jsonl>.'); }
    const cases = readCases(casesPath, config);
    const pairs = evalPairs(config, cases, await collectAnswers(config, cases, text(options, 'answers')));
    const count = (how: TRoute): number => pairs.filter(pair => pair.route === how).length;
    const passing = pairs.filter(pair => !pair.fails).length;
    console.log(`${cases.length} cases, ${pairs.length} judgements (${pairs.length - passing} can fail, ${passing} cannot): ${count('asked')} asked, ${count('rule')} kept by a rule, ${count('paths')} dropped by paths\n`);
    printSweep(pairs);
    const override = text(options, 'threshold') ? positiveNumber(options, 'threshold', 0.2) : undefined;
    const thresholdOf = (job: string): number => override ?? config.jobs[job]!.threshold ?? (config.jev ? config.jev.threshold : 0.2);
    const misses = pairs.filter(pair => pair.fails && pair.p < thresholdOf(pair.job));
    const dropped = pairs.filter(pair => !pair.fails && pair.p < thresholdOf(pair.job)).length;
    console.log(`\nat the configured thresholds: ${misses.length} missed, ${dropped} of ${passing} cannot-fail judgements dropped`);
    for (const miss of misses) { console.log(`missed: ${miss.id} ${miss.job} ${miss.route === 'paths' ? '(not in its paths)' : `P=${miss.p.toFixed(3)}`}`); }
    return misses.length ? 1 : 0;
}

/** This package's version; `package.json` sits one level above both `src/` and `dist/`. */
function version(): string {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }).version;
}

/** The parsed command line, or the exit code after explaining what is wrong with it. */
function commandLine(argv: readonly string[]): { command: string; options: Options } | number {
    let parsed: ReturnType<typeof parse>;
    try {
        parsed = parse(argv);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message.split('. ')[0]! : String(err);
        console.error(`jevci: ${message}.\n\n${usage(argv.find(arg => arg in COMMANDS))}`);
        return 2;
    }
    const { command, options } = parsed;
    if (!command && options.version) {
        console.log(version());
        return 0;
    }
    if (!command || !(command in COMMANDS)) {
        if (command) { console.error(`jevci: unknown command "${command}".\n`); }
        console.log(usage());
        return command || !options.help ? 2 : 0;
    }
    if (options.help) {
        console.log(usage(command));
        return 0;
    }
    const allowed = new Set(COMMANDS[command]!.options.map(option => option.name));
    const stray = Object.keys(options).filter(name => !allowed.has(name));
    if (!stray.length) { return { command, options }; }
    console.error(`jevci ${command}: unknown option ${stray.map(name => `--${name}`).join(', ')}.\n\n${usage(command)}`);
    return 2;
}

const HANDLERS: Record<string, (options: Options) => number | Promise<number>> = { plan, check, init, replay, eval: evaluate };

export async function run(argv: readonly string[]): Promise<number> {
    const parsed = commandLine(argv);
    if (typeof parsed === 'number') { return parsed; }
    try {
        return await HANDLERS[parsed.command]!(parsed.options);
    } catch (err: unknown) {
        if (!(err instanceof JevciConfigError)) { throw err; }
        console.error(`jevci: ${err.message}`);
        return 2;
    }
}
