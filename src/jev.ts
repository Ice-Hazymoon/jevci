/**
 * The Jev HTTP client behind the built-in judge: provider and key resolution, a per-question disk cache,
 * bounded concurrency, and retries for rate limits, server errors and dropped connections.
 * Every provider speaks the same wire format: `{ model, state, questions }` in, `answers[id].noul` out.
 * The model label is part of each cache key, so answers from different models never mix.
 */
import type { JevciProvider } from './config.js';
import type { JevciQuestion, JudgeStats } from './judge.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface Endpoint { name: JevciProvider['kind']; model: string; url?: string; keyName?: string; apiKey?: string }

const DEFAULT_KEYS = { gateway: 'AI_GATEWAY_API_KEY', typesafe: 'TYPESAFE_API_KEY', openrouter: 'OPENROUTER_API_KEY' } as const;
const GATEWAY = { model: 'typesafe-ai/jev', url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone' };
const TYPESAFE = { model: 'jev-1.13.0', url: 'https://api.typesafe.ai/v1/systemone' };
const OPENROUTER = { model: 'typesafe/jev-1.13', url: 'https://openrouter.ai/api/alpha/decisions' };
const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRY_AFTER_SECONDS = 60;

/** The provider's API key is not in the environment. */
export class JevciKeyError extends Error {
    constructor(public readonly keyName: string | undefined) {
        super(keyName
            ? `${keyName} is not set. Export it in the job that runs jevci (jevci never reads .env files), or change jev.provider.`
            : 'no API key: set AI_GATEWAY_API_KEY (Vercel AI Gateway), TYPESAFE_API_KEY (https://typesafe.ai) or OPENROUTER_API_KEY (https://openrouter.ai), or set jev.provider.');
        this.name = 'JevciKeyError';
    }
}

/** A request failed for a reason retrying did not fix, or the replay provider has no cached answer. */
export class JevciRequestError extends Error {
    constructor(message: string, public readonly status?: number) {
        super(message);
        this.name = 'JevciRequestError';
    }
}

/** Endpoint, model and key for a provider; without one, the first provider whose default key is set. */
export function resolveEndpoint(provider: JevciProvider | undefined, env: NodeJS.ProcessEnv): Endpoint {
    const detected = (['gateway', 'typesafe', 'openrouter'] as const).find(kind => env[DEFAULT_KEYS[kind]]?.trim());
    const chosen: JevciProvider | undefined = provider ?? (detected && { kind: detected });
    if (!chosen) { throw new JevciKeyError(undefined); }
    if (chosen.kind === 'replay') { return { name: 'replay', model: chosen.model ?? GATEWAY.model }; }
    const keyName = chosen.keyEnv ?? DEFAULT_KEYS[chosen.kind];
    const apiKey = env[keyName]?.trim();
    if (!apiKey) { throw new JevciKeyError(keyName); }
    const defaults = { gateway: GATEWAY, typesafe: TYPESAFE, openrouter: OPENROUTER }[chosen.kind];
    const model = (chosen.kind !== 'gateway' && chosen.model) || defaults.model;
    return { name: chosen.kind, model, url: defaults.url, keyName, apiKey };
}

/** Cache file of one answer: `<cacheDir>/q/<ab>/<sha256(model, state, question)>.json`. */
export function answerPath(cacheDir: string, model: string, stateJson: string, question: JevciQuestion): string {
    const hash = createHash('sha256').update(model).update('\0').update(stateJson).update('\0').update(JSON.stringify(question)).digest('hex');
    return join(cacheDir, 'q', hash.slice(0, 2), `${hash}.json`);
}

function readAnswer(path: string): number | undefined {
    try {
        const noul: unknown = (JSON.parse(readFileSync(path, 'utf-8')) as { noul?: unknown }).noul;
        return typeof noul === 'number' ? noul : undefined;
    } catch {
        return undefined;
    }
}

/** Temporary file plus rename, so a concurrent reader never sees half an answer. */
function writeAnswer(path: string, noul: number): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ noul }));
    renameSync(temporary, path);
}

function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
    let active = 0;
    const waiting: Array<() => void> = [];
    return async (task) => {
        if (active >= max) { await new Promise<void>(resolve => waiting.push(resolve)); }
        active++;
        try {
            return await task();
        } finally {
            active--;
            waiting.shift()?.();
        }
    };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** `retry-after` when the server sent one, otherwise exponential backoff with jitter. */
function retryDelay(attempt: number, response?: Response): number {
    const retryAfter = Number(response?.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) { return Math.min(retryAfter, MAX_RETRY_AFTER_SECONDS) * 1000; }
    return 500 * 2 ** attempt * (0.5 + Math.random());
}

function failure(endpoint: Endpoint, status: number, body: string): JevciRequestError {
    if (status === 401 || status === 403) { return new JevciRequestError(`${endpoint.name} rejected the API key in ${endpoint.keyName} (HTTP ${status}).`, status); }
    if (status === 402) { return new JevciRequestError(`${endpoint.name} reports no credits left on the account (HTTP 402).`, status); }
    return new JevciRequestError(`${endpoint.name} answered HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ''}`, status);
}

const retryable = (status: number): boolean => status === 429 || status >= 500;

interface WireResponse { answers?: Record<string, { noul?: unknown }>; usage?: { input_tokens?: number } }

export interface JevClientOptions {
    provider?: JevciProvider;
    cacheDir: string;
    concurrency: number;
    env?: NodeJS.ProcessEnv;
}

export interface JevClient {
    /** P(yes) per question id. */
    ask: (state: Record<string, unknown>, questions: Record<string, JevciQuestion>) => Promise<Record<string, number>>;
    readonly name: string;
    readonly stats: JudgeStats;
}

export function createJevClient(options: JevClientOptions): JevClient {
    const endpoint = resolveEndpoint(options.provider, options.env ?? process.env);
    const limit = createLimiter(options.concurrency);
    const stats: JudgeStats = { asked: 0, requests: 0, inputTokens: 0, cacheHits: 0 };

    /** One HTTP attempt: the response, or undefined after waiting when it should be retried. */
    async function attempt(body: string, number: number): Promise<WireResponse | undefined> {
        let response: Response;
        try {
            response = await fetch(endpoint.url!, { method: 'POST', headers: { 'Authorization': `Bearer ${endpoint.apiKey}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        } catch (err: unknown) {
            if (number < MAX_ATTEMPTS) {
                await sleep(retryDelay(number));
                return undefined;
            }
            throw new JevciRequestError(`could not reach ${endpoint.name} after ${number} attempts: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (retryable(response.status) && number < MAX_ATTEMPTS) {
            await sleep(retryDelay(number, response));
            return undefined;
        }
        if (!response.ok) { throw failure(endpoint, response.status, await response.text()); }
        return await response.json() as WireResponse;
    }

    async function post(stateJson: string, questions: Record<string, JevciQuestion>): Promise<WireResponse> {
        const model = endpoint.name === 'gateway' ? 'jev-latest' : endpoint.model;
        const body = `{"model":${JSON.stringify(model)},"state":${stateJson},"questions":${JSON.stringify(questions)}}`;
        for (let number = 1; ; number++) {
            const json = await attempt(body, number);
            if (!json) { continue; }
            stats.requests++;
            stats.inputTokens += json.usage?.input_tokens ?? 0;
            return json;
        }
    }

    async function ask(state: Record<string, unknown>, questions: Record<string, JevciQuestion>): Promise<Record<string, number>> {
        const stateJson = JSON.stringify(state);
        const result: Record<string, number> = {};
        const missing: Record<string, JevciQuestion> = {};
        for (const [id, question] of Object.entries(questions)) {
            const cached = readAnswer(answerPath(options.cacheDir, endpoint.model, stateJson, question));
            if (cached === undefined) { missing[id] = question; } else { result[id] = cached; stats.cacheHits++; }
        }
        const ids = Object.keys(missing);
        if (!ids.length) { return result; }
        if (endpoint.name === 'replay') { throw new JevciRequestError(`replay: no cached answer for ${ids.join(', ')} under model "${endpoint.model}" in ${options.cacheDir}.`); }
        stats.asked += ids.length;
        const json = await limit(() => post(stateJson, missing));
        for (const id of ids) {
            const noul = json.answers?.[id]?.noul;
            if (typeof noul !== 'number') { throw new JevciRequestError(`${endpoint.name} returned no probability for "${id}".`); }
            result[id] = noul;
            writeAnswer(answerPath(options.cacheDir, endpoint.model, stateJson, missing[id]!), noul);
        }
        return result;
    }

    return { ask, name: `${endpoint.name} ${endpoint.model}`, stats };
}
