/**
 * GitHub Actions workflow support: `jevci check` keeps the config and the workflow in step, and
 * `jevci init` drafts a config from a workflow's jobs.
 */
import type { ResolvedJevciConfig } from './config.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { matchesAny, matchesGlob } from './glob.js';

export interface WorkflowJob {
    id: string;
    /** The job's `if:` expression, without `${{ }}`. */
    if?: string;
    needs: string[];
    /** A step runs `jevci plan`. */
    runsPlan: boolean;
    /** `strategy.matrix`, serialized, so the expressions in it can be searched. */
    matrix?: string;
    /** The job's `outputs` map. */
    outputs: Record<string, string>;
}

export interface CheckFinding {
    severity: 'error' | 'warning';
    job?: string;
    message: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `jevci plan`, `npx jevci plan`, `node node_modules/@hazymoon/jevci/dist/bin.mjs plan`, … */
const RUNS_PLAN = /\bjevci\b[^\n]*?\splan\b/;

/** The workflow a repository most likely gates with jevci: one whose steps run `jevci plan`, else `ci.yml`. */
export function findWorkflow(root: string): string | undefined {
    const dir = join(root, '.github', 'workflows');
    if (!existsSync(dir)) { return undefined; }
    const files = readdirSync(dir).filter(name => /\.ya?ml$/.test(name)).map(name => join(dir, name));
    return files.find(file => RUNS_PLAN.test(readFileSync(file, 'utf8'))) ?? files.find(file => /[/\\]ci\.ya?ml$/.test(file)) ?? (files.length === 1 ? files[0] : undefined);
}

function toWorkflowJob(id: string, job: unknown): WorkflowJob {
    const body = isObject(job) ? job : {};
    const needs = Array.isArray(body.needs) ? body.needs.map(String) : typeof body.needs === 'string' ? [body.needs] : [];
    const condition = body.if === undefined ? undefined : String(body.if).replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1').trim();
    const steps = Array.isArray(body.steps) ? body.steps.filter(isObject) : [];
    const matrix = isObject(body.strategy) && body.strategy.matrix !== undefined ? JSON.stringify(body.strategy.matrix) : undefined;
    const outputs = isObject(body.outputs) ? Object.fromEntries(Object.entries(body.outputs).map(([key, value]) => [key, String(value)])) : {};
    return { id, if: condition, needs, runsPlan: steps.some(step => RUNS_PLAN.test(`${String(step.run ?? '')} ${String(step.uses ?? '')}`)), ...(matrix ? { matrix } : {}), outputs };
}

export function readWorkflow(path: string): WorkflowJob[] {
    const document: unknown = parse(readFileSync(path, 'utf8'));
    if (!isObject(document) || !isObject(document.jobs)) { throw new Error(`${path} has no "jobs" map.`); }
    return Object.entries(document.jobs).map(([id, job]) => toWorkflowJob(id, job));
}

/** The recommended `if:` for a gated job: run when the plan says so, and whenever the plan job did not succeed. */
export function guardFor(planJob: string, id: string): string {
    return `\${{ !cancelled() && (needs.${planJob}.result != 'success' || fromJSON(needs.${planJob}.outputs.jobs || '{}')['${id}']) }}`;
}

/** The recommended `if:` for a matrix job: run when any entry is planned, and whenever the plan job did not succeed. */
export function matrixGuardFor(planJob: string, group: string): string {
    return `\${{ !cancelled() && (needs.${planJob}.result != 'success' || needs.${planJob}.outputs.${group} != '[]') }}`;
}

/** The recommended matrix list for a group: the planned entries, or every entry when the plan job did not succeed. */
export function matrixFor(planJob: string, group: string, entries: readonly string[]): string {
    return `\${{ fromJSON(needs.${planJob}.result == 'success' && needs.${planJob}.outputs.${group} || '${JSON.stringify(entries)}') }}`;
}

/** `test/api`, `test/web` → `{ test: ['api', 'web'] }`, in config order. */
export function configGroups(config: ResolvedJevciConfig): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const id of Object.keys(config.jobs)) {
        const slash = id.indexOf('/');
        if (slash === -1) { continue; }
        const group = id.slice(0, slash);
        groups.set(group, [...groups.get(group) ?? [], id.slice(slash + 1)]);
    }
    return groups;
}

/** Whether an `if:` reads this job's entry of the plan's `jobs` output. */
function readsPlan(condition: string, planJob: string, id: string): boolean {
    if (!condition.includes(`needs.${planJob}.outputs.jobs`)) { return false; }
    return condition.includes(`['${id}']`) || condition.includes(`["${id}"]`) || new RegExp(`\\.${id.replace(/-/g, '\\-')}\\b(?!-)`).test(condition);
}

function checkJob(config: ResolvedJevciConfig, job: WorkflowJob, planJob: string): CheckFinding[] {
    const findings: CheckFinding[] = [];
    const error = (message: string): number => findings.push({ severity: 'error', job: job.id, message });
    const warn = (message: string): number => findings.push({ severity: 'warning', job: job.id, message });
    const condition = job.if ?? '';
    if (!job.needs.includes(planJob)) { error(`does not list "${planJob}" in needs, so it cannot read the plan.`); }
    if (!readsPlan(condition, planJob, job.id)) {
        error(`its if: does not read the plan. Use: if: ${guardFor(planJob, job.id)}`);
    } else if (!condition.includes(`needs.${planJob}.result`)) {
        warn(`is skipped when the plan job fails; also run it then: if: ${guardFor(planJob, job.id)}`);
    }
    if (/^\s*TODO\b/i.test(config.jobs[job.id]!.checks)) { warn('`checks` is still a TODO; Jev judges this job by that text.'); }
    return findings;
}

/** A matrix job gated by its group output: the job runs when any entry is planned, and the matrix lists the planned entries. */
function checkGroup(job: WorkflowJob, planJob: string, entries: readonly string[]): CheckFinding[] {
    const findings: CheckFinding[] = [];
    const error = (message: string): number => findings.push({ severity: 'error', job: job.id, message });
    const output = `needs.${planJob}.outputs.${job.id}`;
    if (!job.needs.includes(planJob)) { error(`does not list "${planJob}" in needs, so it cannot read the plan.`); }
    if (!(job.if ?? '').includes(output)) {
        error(`its if: does not read ${output}. Use: if: ${matrixGuardFor(planJob, job.id)}`);
    } else if (!(job.if ?? '').includes(`needs.${planJob}.result`)) {
        findings.push({ severity: 'warning', job: job.id, message: `is skipped when the plan job fails; also run it then: if: ${matrixGuardFor(planJob, job.id)}` });
    }
    if (!job.matrix?.includes(output)) {
        error(`its strategy.matrix does not read ${output}, so every entry runs whatever the plan says. List the entries with: ${matrixFor(planJob, job.id, entries)}`);
    } else {
        const unlisted = entries.filter(entry => !job.matrix!.includes(`"${entry}"`) && !job.matrix!.includes(`\\"${entry}\\"`));
        if (unlisted.length) { error(`the matrix fallback (used when the plan job fails) misses ${unlisted.join(', ')}. Use: ${matrixFor(planJob, job.id, entries)}`); }
    }
    return findings;
}

/** Outputs the plan job must forward so the gated jobs can read them. */
function checkPlanOutputs(plan: WorkflowJob, config: ResolvedJevciConfig, groups: ReadonlyMap<string, readonly string[]>): CheckFinding[] {
    const wanted = [...(Object.keys(config.jobs).some(id => !id.includes('/')) ? ['jobs'] : []), ...groups.keys()];
    return wanted.filter(name => !plan.outputs[name]?.includes(`outputs.${name}`)).map(name => ({ severity: 'error' as const, job: plan.id, message: `does not forward the "${name}" output. Add under outputs: ${name}: \${{ steps.<plan step id>.outputs.${name} }}` }));
}

/** The plan job's id, or an error finding when it is missing or ambiguous. */
function findPlanJob(jobs: readonly WorkflowJob[], planJobId: string | undefined): string | CheckFinding {
    if (planJobId) { return jobs.some(job => job.id === planJobId) ? planJobId : { severity: 'error', message: `plan job "${planJobId}" is not in the workflow.` }; }
    const planners = jobs.filter(job => job.runsPlan);
    if (planners.length === 1) { return planners[0]!.id; }
    return { severity: 'error', message: planners.length ? `several jobs run \`jevci plan\` (${planners.map(job => job.id).join(', ')}); pass --plan-job.` : 'no job runs `jevci plan`; add a plan job (see `jevci init`).' };
}

/** Every mismatch between the config and the workflow that would run a job jevci skipped, or skip one it planned. */
export function checkWorkflow(config: ResolvedJevciConfig, jobs: readonly WorkflowJob[], planJobId?: string): CheckFinding[] {
    const planJob = findPlanJob(jobs, planJobId);
    if (typeof planJob !== 'string') { return [planJob]; }
    const byId = new Map(jobs.map(job => [job.id, job]));
    const groups = configGroups(config);
    const single = Object.keys(config.jobs).filter(id => !id.includes('/'));
    const missing = [...single, ...groups.keys()].filter(id => !byId.has(id)).map(id => ({ severity: 'error' as const, job: id, message: 'is in the config but not in the workflow; rename or remove it.' }));
    const gated = single.flatMap(id => (byId.has(id) ? checkJob(config, byId.get(id)!, planJob) : []));
    const matrices = [...groups].flatMap(([group, entries]) => (byId.has(group) ? checkGroup(byId.get(group)!, planJob, entries) : []));
    const ungoverned = jobs.filter(job => job.id !== planJob && !(job.id in config.jobs) && !groups.has(job.id)).map(job => ({ severity: 'warning' as const, job: job.id, message: 'is not in the config, so it runs on every change.' }));
    return [...checkPlanOutputs(byId.get(planJob)!, config, groups), ...missing, ...gated, ...matrices, ...ungoverned];
}

/** The `paths` / `paths-ignore` filter of one workflow trigger. */
export interface PathFilter { paths?: readonly string[]; pathsIgnore?: readonly string[] }

/** The path filter of `event` in a workflow file, when it has one. */
export function readPathFilter(path: string, event: string): PathFilter | undefined {
    const document: unknown = parse(readFileSync(path, 'utf8'));
    const on = isObject(document) ? document.on : undefined;
    const trigger = isObject(on) ? on[event] : undefined;
    if (!isObject(trigger)) { return undefined; }
    const list = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.map(String) : undefined);
    const filter = { paths: list(trigger.paths), pathsIgnore: list(trigger['paths-ignore']) };
    return filter.paths || filter.pathsIgnore ? filter : undefined;
}

/**
 * Whether a change to `files` triggers the workflow, as GitHub decides it: with `paths-ignore`, unless every
 * file is ignored; with `paths`, when a file matches, a later `!pattern` excluding what an earlier one included.
 */
export function triggersWorkflow(filter: PathFilter | undefined, files: readonly string[]): boolean {
    if (!filter) { return true; }
    if (filter.pathsIgnore) { return files.some(file => !matchesAny(filter.pathsIgnore!, file)); }
    return files.some((file) => {
        let included = false;
        for (const pattern of filter.paths ?? []) {
            if (pattern.startsWith('!')) {
                if (matchesGlob(file, pattern.slice(1))) { included = false; }
            } else if (matchesGlob(file, pattern)) {
                included = true;
            }
        }
        return included;
    });
}

/** Linters and formatters read comments and layout, so a draft runs them on comment- and format-only edits too. */
const FORMATTING_JOB = /lint|format|style|prettier|biome/i;

/** A starting `jevci.config.ts` for these job ids. */
export function draftConfig(jobIds: readonly string[]): string {
    const ids = jobIds.length ? jobIds : ['lint', 'test', 'build'];
    const formatting = ids.filter(id => FORMATTING_JOB.test(id));
    const jobs = ids.map((id) => {
        const flag = formatting.includes(id) ? '\n            // Reads comments and layout, so it also runs when only they change.\n            formatting: true,' : '';
        return `        '${id}': {\n            checks: 'TODO: what this job verifies, and what it cannot observe.',${flag}\n        },`;
    }).join('\n');
    return `import { defineConfig } from '@hazymoon/jevci';

export default defineConfig({
    // A change here runs every job: dependencies, lockfiles, CI and build configuration.
    full: ['package.json', '**/package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', '.github/**', 'jevci.config.ts'],
    // No job reads these. A change made only of them skips CI.
    ignore: ['**/*.md', 'docs/**', 'LICENSE'],
    // Run on any real change, so skipping everything stays a rule-based decision.
    minimumJobs: ['${formatting[0] ?? ids[0]}'],
    jobs: {
${jobs}
    },
});
`;
}

/** The plan job and one gated job, for a workflow's README or `jevci init` output. */
export function workflowSnippet(planJob: string, example: string): string {
    return `jobs:
  ${planJob}:
    runs-on: ubuntu-latest
    outputs:
      jobs: \${{ steps.plan.outputs.jobs }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      # Only jevci is installed; the project's dependencies are not needed to plan.
      - id: plan
        run: npx --yes @hazymoon/jevci plan --format github
        env:
          AI_GATEWAY_API_KEY: \${{ secrets.AI_GATEWAY_API_KEY }}

  ${example}:
    needs: ${planJob}
    if: ${guardFor(planJob, example)}
    # ...the job's own steps`;
}
