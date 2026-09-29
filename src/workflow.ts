/**
 * GitHub Actions workflow support: `jevci check` keeps the config and the workflow in step, and
 * `jevci init` drafts a config from a workflow's jobs.
 */
import type { ResolvedJevciConfig } from './config.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export interface WorkflowJob {
    id: string;
    /** The job's `if:` expression, without `${{ }}`. */
    if?: string;
    needs: string[];
    /** A step runs `jevci plan`. */
    runsPlan: boolean;
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
    return { id, if: condition, needs, runsPlan: steps.some(step => RUNS_PLAN.test(`${String(step.run ?? '')} ${String(step.uses ?? '')}`)) };
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
    const missing = Object.keys(config.jobs).filter(id => !byId.has(id)).map(id => ({ severity: 'error' as const, job: id, message: 'is in the config but not in the workflow; rename or remove it.' }));
    const gated = Object.keys(config.jobs).flatMap(id => (byId.has(id) ? checkJob(config, byId.get(id)!, planJob) : []));
    const ungoverned = jobs.filter(job => job.id !== planJob && !(job.id in config.jobs)).map(job => ({ severity: 'warning' as const, job: job.id, message: 'is not in the config, so it runs on every change.' }));
    return [...missing, ...gated, ...ungoverned];
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
