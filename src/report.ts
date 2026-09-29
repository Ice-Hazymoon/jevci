/**
 * Plan output: terminal text, Markdown (a step summary or a pull request comment), GitHub step outputs,
 * and dotenv lines for other CI systems.
 */
import type { FilePlan, Plan } from './plan.js';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

export type TReportFormat = 'text' | 'json' | 'markdown' | 'github' | 'dotenv';
export const REPORT_FORMATS: readonly TReportFormat[] = ['text', 'json', 'markdown', 'github', 'dotenv'];

const HEADLINE = { none: 'skip every job', partial: 'run some jobs', full: 'run every job' } as const;

function judgeLine(plan: Plan): string | undefined {
    const judge = plan.judge;
    if (!judge) { return undefined; }
    const usage = [judge.asked !== undefined && `${judge.asked} questions`, judge.inputTokens !== undefined && `${judge.inputTokens} input tokens`, judge.cacheHits !== undefined && `${judge.cacheHits} cached`].filter(Boolean);
    return `judge: ${judge.name ?? 'custom'}${usage.length ? ` (${usage.join(', ')})` : ''}`;
}

function fileLine(file: FilePlan, width: number): string {
    const jev = file.jev ? `  P{${Object.entries(file.jev).map(([id, p]) => `${id}=${p.toFixed(2)}`).join(' ')}}` : '';
    const runs = file.runs.length ? ` → ${file.runs.join(', ')}` : '';
    const path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
    return `  ${file.verdict.padEnd(width)}  ${path}${runs}${jev}${file.note ? ` (${file.note})` : ''}`;
}

export function formatText(plan: Plan): string {
    const lines = [`jevci: ${HEADLINE[plan.level]} (${plan.reason})`];
    if (plan.base && plan.head) { lines.push(`range: ${plan.base.slice(0, 12)}..${plan.head.slice(0, 12)}`); }
    if (plan.fallback) { lines.push(`fallback: ${plan.fallback}`); }
    const idWidth = Math.max(...Object.keys(plan.jobs).map(id => id.length));
    lines.push(...Object.entries(plan.jobs).map(([id, job]) => `  ${job.run ? 'run ' : 'skip'}  ${id.padEnd(idWidth)}  ${job.reason}`));
    if (plan.files.length) {
        const verdictWidth = Math.max(...plan.files.map(file => file.verdict.length));
        lines.push('files:', ...plan.files.map(file => fileLine(file, verdictWidth)));
    }
    if (plan.minutes.full) { lines.push(`job minutes: ${plan.minutes.planned.toFixed(1)} of ${plan.minutes.full.toFixed(1)}`); }
    const judge = judgeLine(plan);
    return (judge ? [...lines, judge] : lines).join('\n');
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function formatMarkdown(plan: Plan): string {
    const lines = [`### jevci: ${HEADLINE[plan.level]}`, '', cell(plan.reason)];
    if (plan.fallback) { lines.push('', `> **Fallback:** ${cell(plan.fallback)}`); }
    lines.push('', '| Job | Runs | Why |', '| --- | --- | --- |');
    for (const [id, job] of Object.entries(plan.jobs)) { lines.push(`| \`${id}\` | ${job.run ? 'yes' : 'no'} | ${cell(job.reason)} |`); }
    if (plan.files.length) {
        lines.push('', `<details><summary>${plan.files.length} changed file${plan.files.length === 1 ? '' : 's'}</summary>`, '', '| File | Verdict | Runs |', '| --- | --- | --- |');
        for (const file of plan.files) { lines.push(`| \`${cell(file.path)}\` | ${file.verdict} | ${file.runs.join(', ') || '—'} |`); }
        lines.push('', '</details>');
    }
    if (plan.minutes.full) { lines.push('', `Job minutes: ${plan.minutes.planned.toFixed(1)} of ${plan.minutes.full.toFixed(1)}.`); }
    const judge = judgeLine(plan);
    if (judge) { lines.push('', cell(judge)); }
    return `${lines.join('\n')}\n`;
}

/** Step outputs: `level`, `jobs` (JSON object of job id → boolean), `reason`, `fallback`. */
export function githubOutputs(plan: Plan): Record<string, string> {
    return {
        level: plan.level,
        jobs: JSON.stringify(Object.fromEntries(Object.entries(plan.jobs).map(([id, job]) => [id, job.run]))),
        reason: plan.reason,
        fallback: plan.fallback ?? '',
    };
}

/** Appends the outputs to `$GITHUB_OUTPUT` and the Markdown summary to `$GITHUB_STEP_SUMMARY`, when set. */
export function writeGithub(plan: Plan, env: NodeJS.ProcessEnv = process.env): void {
    if (env.GITHUB_OUTPUT) {
        const text = Object.entries(githubOutputs(plan)).map(([key, value]) => {
            const delimiter = `JEVCI_${randomUUID()}`;
            return `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
        }).join('');
        appendFileSync(env.GITHUB_OUTPUT, text);
    }
    if (env.GITHUB_STEP_SUMMARY) { appendFileSync(env.GITHUB_STEP_SUMMARY, formatMarkdown(plan)); }
}

/** The variable a job's decision is exported as: `lint` → `JEVCI_RUN_LINT`, `test-e2e` → `JEVCI_RUN_TEST_E2E`. */
export function jobVariable(id: string): string {
    return `JEVCI_RUN_${id.toUpperCase().replace(/-/g, '_')}`;
}

/** `JEVCI_LEVEL` and one `JEVCI_RUN_<JOB>=true|false` per job, e.g. for a GitLab `dotenv` report. */
export function formatDotenv(plan: Plan): string {
    return `${[`JEVCI_LEVEL=${plan.level}`, ...Object.entries(plan.jobs).map(([id, job]) => `${jobVariable(id)}=${job.run}`)].join('\n')}\n`;
}

/** The plan in `format`; `github` renders as text (its outputs are written by `writeGithub`). */
export function formatPlan(plan: Plan, format: TReportFormat): string {
    switch (format) {
        case 'json': return `${JSON.stringify(plan, null, 2)}\n`;
        case 'markdown': return formatMarkdown(plan);
        case 'dotenv': return formatDotenv(plan);
        default: return `${formatText(plan)}\n`;
    }
}
