/**
 * What the CI run is about: event, commit range, labels and description, read from the CI provider's
 * environment. Explicit command-line values always win over what is detected here.
 */
import { existsSync, readFileSync } from 'node:fs';

export type TCiProvider = 'github' | 'gitlab' | 'local';

export interface CiContext {
    provider: TCiProvider;
    /** Event name as the provider spells it (`push`, `pull_request`, `merge_request_event`, `schedule`, …). */
    event?: string;
    base?: string;
    head?: string;
    labels?: string[];
    /** Pull or merge request description. */
    body?: string;
}

interface GithubPayload {
    before?: string;
    after?: string;
    pull_request?: { base?: { sha?: string }; head?: { sha?: string }; labels?: Array<{ name?: string }>; body?: string | null };
    merge_group?: { base_sha?: string; head_sha?: string };
}

function githubContext(env: NodeJS.ProcessEnv): CiContext {
    const context: CiContext = { provider: 'github', event: env.GITHUB_EVENT_NAME, head: env.GITHUB_SHA };
    if (!env.GITHUB_EVENT_PATH || !existsSync(env.GITHUB_EVENT_PATH)) { return context; }
    const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as GithubPayload;
    if (payload.pull_request) {
        const pr = payload.pull_request;
        return { ...context, base: pr.base?.sha, head: pr.head?.sha ?? context.head, labels: (pr.labels ?? []).map(label => label.name ?? '').filter(Boolean), body: pr.body ?? undefined };
    }
    if (payload.merge_group) { return { ...context, base: payload.merge_group.base_sha, head: payload.merge_group.head_sha ?? context.head }; }
    if (payload.before) { return { ...context, base: payload.before, head: payload.after ?? context.head }; }
    return context;
}

function gitlabContext(env: NodeJS.ProcessEnv): CiContext {
    const labels = env.CI_MERGE_REQUEST_LABELS?.split(',').map(label => label.trim()).filter(Boolean);
    return {
        provider: 'gitlab',
        event: env.CI_PIPELINE_SOURCE,
        base: env.CI_MERGE_REQUEST_DIFF_BASE_SHA || env.CI_COMMIT_BEFORE_SHA,
        head: env.CI_COMMIT_SHA,
        labels,
        body: env.CI_MERGE_REQUEST_DESCRIPTION,
    };
}

/** Detects GitHub Actions or GitLab CI from `env`; anywhere else the context is `local` and empty. */
export function detectContext(env: NodeJS.ProcessEnv = process.env): CiContext {
    if (env.GITHUB_ACTIONS === 'true') { return githubContext(env); }
    if (env.GITLAB_CI === 'true') { return gitlabContext(env); }
    return { provider: 'local' };
}
