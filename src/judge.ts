/**
 * The Jev step: for one changed file, P(the change can make each candidate job fail).
 * One request per file: the state carries the diff, the evidence and every candidate job's description,
 * and each job is an independent question. Any judge with the same `ask` shape can stand in for Jev.
 */
import type { JevciProvider, ResolvedJevOptions } from './config.js';
import type { Evidence } from './evidence.js';
import { createJevClient } from './jev.js';

/** A yes/no question; the judge returns P(yes). */
export interface JevciQuestion {
    type: 'noul';
    instructions: string;
    criteria: { true: string; false: string };
}

export interface JudgeStats {
    asked: number;
    requests: number;
    inputTokens: number;
    cacheHits: number;
}

/** What answers the questions: the built-in Jev client, or anything with the same `ask`. */
export interface JevciJudge {
    /** P(yes) per question id. */
    ask: (state: Record<string, unknown>, questions: Record<string, JevciQuestion>) => Promise<Record<string, number>>;
    /** Shown in reports, e.g. `gateway typesafe-ai/jev`. */
    readonly name?: string;
    readonly stats?: JudgeStats;
}

export interface JudgeCase {
    /** Path of the changed file. */
    file: string;
    /** Unified diff of the file, header lines dropped. */
    diff: string;
    evidence: Evidence;
    /** Candidate jobs: id → what the job checks. */
    jobs: Record<string, string>;
    /** Repository context from `jev.context`. */
    context?: string;
}

export function judgeState(input: JudgeCase): Record<string, unknown> {
    return {
        ...(input.context ? { repository: input.context } : {}),
        file: input.file,
        change: input.diff,
        tests_containing_removed_text: input.evidence.testsContainingRemovedText,
        removed_text_not_found_in_tests: input.evidence.removedTextNotInTests,
        ci_jobs: input.jobs,
    };
}

export function judgeQuestion(jobId: string): JevciQuestion {
    return {
        type: 'noul',
        instructions: `\`change\` is a unified diff of \`file\` ("-" lines removed, "+" lines added). Assume CI job \`ci_jobs.${jobId}\` passed before this change. Could this change make that job fail?`,
        criteria: {
            true: 'Yes, or it cannot be ruled out: the job reads something that changed, such as code, types, imports, template structure or bindings, compiled styles, configuration, test code, or text a test asserts (see `tests_containing_removed_text`).',
            false: 'No: nothing the job checks can observe this change, for example it only rewords user-visible copy that no test, type or lint rule reads, so the job passes exactly as before.',
        },
    };
}

export function judgeQuestions(jobs: Record<string, string>): Record<string, JevciQuestion> {
    return Object.fromEntries(Object.keys(jobs).map(id => [id, judgeQuestion(id)]));
}

/** Rough input tokens for one case (code tokenizes densely, so this errs high). */
export function judgeTokens(input: JudgeCase): number {
    return Math.ceil((JSON.stringify(judgeState(input)).length + JSON.stringify(judgeQuestions(input.jobs)).length) / 3);
}

/** P(the change can make the job fail) per case and job, in case order. */
export async function judgeCases(judge: JevciJudge, cases: readonly JudgeCase[]): Promise<Array<Record<string, number>>> {
    return Promise.all(cases.map(input => judge.ask(judgeState(input), judgeQuestions(input.jobs))));
}

/** The built-in Jev judge. Throws `JevciKeyError` when the provider's API key is missing. */
export function createJevJudge(options: Pick<ResolvedJevOptions, 'cacheDir' | 'concurrency'> & { provider?: JevciProvider; env?: NodeJS.ProcessEnv }): JevciJudge {
    return createJevClient(options);
}
