import { createJiti } from 'jiti';
/**
 * `jevci.config.{ts,mts,js,mjs}`: the CI jobs, which paths matter to each, and how far Jev may narrow them.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One CI job, keyed by the job id the workflow uses. */
export interface JevciJob {
    /** What the job verifies, in a sentence or two, including what it cannot observe. Jev reads this. */
    checks: string;
    /** Globs of files whose changes can matter to the job. Default `['**']`. */
    paths?: readonly string[];
    /** Globs removed from `paths`. */
    exclude?: readonly string[];
    /** Globs the job executes or reads directly (its own tests, its config): a real change here runs the job without asking Jev. */
    owns?: readonly string[];
    /** `false`: every real change in the job's paths runs it; Jev never drops it. Default `true`. */
    downgrade?: boolean;
    /** The job reads comments or formatting itself (a linter, formatter or spell checker), so comment- and whitespace-only changes still run it. */
    formatting?: boolean;
    /** Overrides `jev.threshold` for this job. */
    threshold?: number;
    /** Typical duration in minutes, for savings reports. */
    minutes?: number;
}

/** Normalizes one file type for comment- and format-only change detection. */
export interface JevciNormalizer {
    /** Globs of the files it handles. Custom normalizers are tried in order, before the built-in ones. */
    files: readonly string[];
    /**
     * The content with everything no job can observe removed (comments, layout). Two versions that
     * normalize to the same string count as a no-op. Return `undefined` when unsure: the change is then real.
     */
    normalize: (text: string, path: string) => string | undefined;
}

/**
 * Where Jev answers come from.
 * - `gateway`: Vercel AI Gateway; key from `keyEnv` (default `AI_GATEWAY_API_KEY`).
 * - `typesafe`: api.typesafe.ai, pinned to `model`; key from `keyEnv` (default `TYPESAFE_API_KEY`).
 * - `openrouter`: OpenRouter's decisions endpoint, pinned to `model` (default `typesafe/jev-1.13`); key from `keyEnv` (default `OPENROUTER_API_KEY`).
 * - `replay`: cached answers only; a miss is an error and nothing is sent.
 */
export type JevciProvider
    = | { kind: 'gateway'; keyEnv?: string }
        | { kind: 'typesafe'; keyEnv?: string; model?: string }
        | { kind: 'openrouter'; keyEnv?: string; model?: string }
        | { kind: 'replay'; model?: string };

export interface JevciJevOptions {
    /** Default: the first of `gateway`, `typesafe`, `openrouter` whose key is set. Without a key, the rules alone decide. */
    provider?: JevciProvider;
    /** A job is kept when P(the change can make it fail) ≥ threshold. Lower is safer. Default 0.2. */
    threshold?: number;
    /** A few sentences about the repository that help judge a change (framework, test style, build-time code). */
    context?: string;
    /** Globs of test files searched for text a change removes; the hits are shown to Jev. */
    testFiles?: readonly string[];
    /** Answer cache; `~` expands to the home directory. Default `$XDG_CACHE_HOME/jevci` or `~/.cache/jevci`. */
    cacheDir?: string;
    /** Parallel requests. Default 8. */
    concurrency?: number;
    /** More changed files than this skips Jev; their jobs run. Default 80. */
    maxFiles?: number;
    /** A file diff longer than this skips Jev for that file. Default 16000 characters. */
    maxDiffChars?: number;
    /** Estimated input tokens for one plan above this skips Jev. Default 400000. */
    maxTokens?: number;
    /** Jev taking longer than this keeps every job the rules chose. Default 180. */
    timeoutSeconds?: number;
}

/** The object a `jevci.config.ts` default-exports. Only `jobs` is required. */
export interface JevciConfig {
    /** Every CI job jevci decides for, keyed by job id. */
    jobs: Record<string, JevciJob>;
    /** Globs whose changes run every job: dependencies, lockfiles, CI and build config, schema. */
    full?: readonly string[];
    /** Globs no job reads (documentation). Added or edited files here are dropped; deleted or renamed ones still count, since a link may point at them. */
    ignore?: readonly string[];
    /** Jobs that run whenever any real change exists, so skipping everything stays a rule-based decision. */
    minimumJobs?: readonly string[];
    /** What runs every job regardless of the change. */
    force?: {
        /** Text in a commit message or pull request body. Default `['[ci full]']`. */
        markers?: readonly string[];
        /** Pull request labels. Default `['ci:full']`. */
        labels?: readonly string[];
        /** CI event names. Default `['schedule', 'workflow_dispatch', 'web']`. */
        events?: readonly string[];
    };
    /** Comment- and format-only change detection; `false` treats every edit as real. */
    noop?: false | {
        /** Comments that change tool behaviour (`@ts-expect-error`, `eslint-disable`, `#__PURE__`); editing one is a real change. Default `DEFAULT_DIRECTIVES`. */
        directives?: RegExp;
        /** Extra file types, tried before the built-in ones. */
        normalizers?: readonly JevciNormalizer[];
    };
    /** Jev settings; `false` never asks Jev, so the rules alone decide. */
    jev?: false | JevciJevOptions;
}

export interface ResolvedJevciJob {
    checks: string;
    paths: readonly string[];
    exclude: readonly string[];
    owns: readonly string[];
    downgrade: boolean;
    formatting: boolean;
    threshold?: number;
    minutes?: number;
}

export interface ResolvedJevOptions {
    provider?: JevciProvider;
    threshold: number;
    context?: string;
    testFiles: readonly string[];
    cacheDir: string;
    concurrency: number;
    maxFiles: number;
    maxDiffChars: number;
    maxTokens: number;
    timeoutSeconds: number;
}

export interface ResolvedJevciConfig {
    root: string;
    configPath?: string;
    jobs: Record<string, ResolvedJevciJob>;
    full: readonly string[];
    ignore: readonly string[];
    minimumJobs: readonly string[];
    force: { markers: readonly string[]; labels: readonly string[]; events: readonly string[] };
    noop: false | { directives: RegExp; normalizers: readonly JevciNormalizer[] };
    jev: false | ResolvedJevOptions;
}

/** Comments that tools read: type-checker and linter suppressions, bundler hints, coverage pragmas, JSDoc types. */
export const DEFAULT_DIRECTIVES = /@ts-(?:expect-error|ignore|nocheck|check)|eslint|prettier-ignore|biome-ignore|istanbul|[cv]8 ignore|#__PURE__|@__PURE__|@__NO_SIDE_EFFECTS__|webpack[A-Z]|@vite-ignore|<reference|@jsx|@vitest-environment|@jest-environment|sourceMappingURL|@deprecated|@type\b|@typedef|@template|@satisfies|@param\s*\{|@returns?\s*\{/;

const CONFIG_FILE_NAMES = ['jevci.config.ts', 'jevci.config.mts', 'jevci.config.js', 'jevci.config.mjs'];
const JOB_ID = /^[\w-]+(?:\/[\w-]+)?$/;
/** Plan outputs a matrix group may not be named after. */
const RESERVED_OUTPUTS = new Set(['level', 'jobs', 'reason', 'fallback']);

/** The config is malformed; the message names every problem. */
export class JevciConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JevciConfigError';
    }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);

/** How one config field is validated: a predicate and the phrase completing "must be …". */
interface Field { valid: (value: unknown) => boolean; expected: string }

const STRINGS: Field = { valid: isStringList, expected: 'an array of non-empty strings' };
const TEXT: Field = { valid: value => typeof value === 'string', expected: 'a string' };
const BOOLEAN: Field = { valid: value => typeof value === 'boolean', expected: 'a boolean' };
const PROBABILITY: Field = { valid: value => typeof value === 'number' && value > 0 && value < 1, expected: 'a number between 0 and 1' };
const POSITIVE: Field = { valid: value => typeof value === 'number' && Number.isFinite(value) && value > 0, expected: 'a positive number' };
const OBJECT_OR_FALSE: Field = { valid: value => value === false || isObject(value), expected: 'false or an object' };

const CONFIG_FIELDS: Record<string, Field> = {
    jobs: { valid: value => isObject(value) && Object.keys(value).length > 0, expected: 'an object with at least one job' },
    full: STRINGS,
    ignore: STRINGS,
    minimumJobs: STRINGS,
    force: { valid: isObject, expected: 'an object' },
    noop: OBJECT_OR_FALSE,
    jev: OBJECT_OR_FALSE,
};
const JOB_FIELDS: Record<string, Field> = {
    checks: { valid: value => typeof value === 'string' && value.trim().length >= 10, expected: 'a sentence or two on what the job verifies (Jev reads it)' },
    paths: STRINGS,
    exclude: STRINGS,
    owns: STRINGS,
    downgrade: BOOLEAN,
    formatting: BOOLEAN,
    threshold: PROBABILITY,
    minutes: POSITIVE,
};
const FORCE_FIELDS: Record<string, Field> = { markers: STRINGS, labels: STRINGS, events: STRINGS };
const NOOP_FIELDS: Record<string, Field> = {
    directives: { valid: value => value instanceof RegExp, expected: 'a RegExp' },
    normalizers: {
        valid: value => Array.isArray(value) && value.every(item => isObject(item) && isStringList(item.files) && typeof item.normalize === 'function'),
        expected: 'an array of { files: string[], normalize(text, path) }',
    },
};
const JEV_FIELDS: Record<string, Field> = {
    provider: { valid: value => isObject(value) && ['gateway', 'typesafe', 'openrouter', 'replay'].includes(String(value.kind)), expected: '{ kind: "gateway" | "typesafe" | "openrouter" | "replay" }' },
    threshold: PROBABILITY,
    context: TEXT,
    testFiles: STRINGS,
    cacheDir: TEXT,
    concurrency: POSITIVE,
    maxFiles: POSITIVE,
    maxDiffChars: POSITIVE,
    maxTokens: POSITIVE,
    timeoutSeconds: POSITIVE,
};

/** Unknown keys, and present (or required) fields that fail their check. */
function fieldProblems(value: Record<string, unknown>, fields: Record<string, Field>, where: string, required: readonly string[] = []): string[] {
    const found = Object.keys(value).filter(key => !(key in fields)).map(key => `${where}: unknown key "${key}".`);
    for (const [key, field] of Object.entries(fields)) {
        const checked = value[key] !== undefined || required.includes(key);
        if (checked && !field.valid(value[key])) { found.push(`${where}.${key} must be ${field.expected}.`); }
    }
    return found;
}

function jobProblems(id: string, job: unknown): string[] {
    const where = `jobs["${id}"]`;
    const group = id.includes('/') ? id.slice(0, id.indexOf('/')) : undefined;
    const badId = !JOB_ID.test(id)
        ? [`${where}: a job id may contain letters, digits, "-" and "_", plus one "/" between a matrix job and its entry (it becomes an output key).`]
        : group && RESERVED_OUTPUTS.has(group) ? [`${where}: "${group}" is a plan output of its own, so it cannot name a matrix group.`] : [];
    return [...badId, ...(isObject(job) ? fieldProblems(job, JOB_FIELDS, where, ['checks']) : [`${where} must be an object.`])];
}

function problems(config: unknown): string[] {
    if (!isObject(config)) { return ['The config must be an object: `export default defineConfig({ jobs: { ... } })`.']; }
    const found = fieldProblems(config, CONFIG_FIELDS, 'config', ['jobs']);
    const jobs = isObject(config.jobs) ? config.jobs : {};
    found.push(...Object.entries(jobs).flatMap(([id, job]) => jobProblems(id, job)));
    const groups = new Set(Object.keys(jobs).filter(id => id.includes('/')).map(id => id.slice(0, id.indexOf('/'))));
    found.push(...[...groups].filter(group => group in jobs).map(group => `jobs["${group}"]: "${group}" is also a matrix group ("${group}/…"); a workflow job is either one job or a matrix.`));
    const minimum = isStringList(config.minimumJobs) ? config.minimumJobs : [];
    found.push(...minimum.filter(id => !(id in jobs)).map(id => `config.minimumJobs names unknown job "${id}".`));
    const sections: Array<[unknown, Record<string, Field>, string]> = [[config.force, FORCE_FIELDS, 'force'], [config.noop, NOOP_FIELDS, 'noop'], [config.jev, JEV_FIELDS, 'jev']];
    for (const [value, fields, where] of sections) {
        if (isObject(value)) { found.push(...fieldProblems(value, fields, where)); }
    }
    return found;
}

/** Identity helper for a typed config file; rejects unknown keys and invalid values early. */
export function defineConfig(config: JevciConfig): JevciConfig {
    const found = problems(config);
    if (found.length) { throw new JevciConfigError(found.join('\n')); }
    return config;
}

function expandHome(path: string): string {
    return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

function resolveJev(jev: JevciJevOptions, root: string, env: NodeJS.ProcessEnv): ResolvedJevOptions {
    return {
        provider: jev.provider,
        threshold: jev.threshold ?? 0.2,
        context: jev.context?.trim() || undefined,
        testFiles: jev.testFiles ?? ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'test/**', 'tests/**'],
        cacheDir: jev.cacheDir ? resolve(root, expandHome(jev.cacheDir)) : join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'jevci'),
        concurrency: jev.concurrency ?? 8,
        maxFiles: jev.maxFiles ?? 80,
        maxDiffChars: jev.maxDiffChars ?? 16_000,
        maxTokens: jev.maxTokens ?? 400_000,
        timeoutSeconds: jev.timeoutSeconds ?? 180,
    };
}

function resolveJob(job: JevciJob): ResolvedJevciJob {
    return {
        checks: job.checks.trim(),
        paths: job.paths ?? ['**'],
        exclude: job.exclude ?? [],
        owns: job.owns ?? [],
        downgrade: job.downgrade ?? true,
        formatting: job.formatting ?? false,
        threshold: job.threshold,
        minutes: job.minutes,
    };
}

function resolveForce(force: JevciConfig['force'] = {}): ResolvedJevciConfig['force'] {
    return {
        markers: force.markers ?? ['[ci full]'],
        labels: force.labels ?? ['ci:full'],
        events: force.events ?? ['schedule', 'workflow_dispatch', 'web'],
    };
}

/** Validates `config` and fills in defaults; relative paths resolve against `root`. */
export function resolveConfig(config: JevciConfig, root: string, configPath?: string, env: NodeJS.ProcessEnv = process.env): ResolvedJevciConfig {
    const found = problems(config);
    if (found.length) { throw new JevciConfigError(found.join('\n')); }
    // A global or sticky RegExp keeps state between `test` calls; directives are matched statelessly.
    const directives = config.noop ? config.noop.directives : undefined;
    const noop = config.noop === false ? false : { directives: directives ? new RegExp(directives.source, directives.flags.replace(/[gy]/g, '')) : DEFAULT_DIRECTIVES, normalizers: config.noop?.normalizers ?? [] };
    return {
        root,
        configPath,
        jobs: Object.fromEntries(Object.entries(config.jobs).map(([id, job]) => [id, resolveJob(job)])),
        full: config.full ?? [],
        ignore: config.ignore ?? [],
        minimumJobs: config.minimumJobs ?? [],
        force: resolveForce(config.force),
        noop,
        jev: config.jev === false ? false : resolveJev(config.jev ?? {}, root, env),
    };
}

/** The nearest `jevci.config.*` in `startDir` or a parent directory. */
export function findConfigFile(startDir: string): string | undefined {
    for (let dir = resolve(startDir); ; dir = dirname(dir)) {
        const found = CONFIG_FILE_NAMES.map(name => join(dir, name)).find(candidate => existsSync(candidate));
        if (found) { return found; }
        if (dirname(dir) === dir) { return undefined; }
    }
}

/** Loads `configPath` (relative to `cwd`) or the nearest config file and resolves it. TypeScript configs load through jiti. */
export async function loadConfig(configPath?: string, cwd: string = process.cwd()): Promise<ResolvedJevciConfig> {
    const path = configPath ? resolve(cwd, configPath) : findConfigFile(cwd);
    if (!path) { throw new JevciConfigError(`No jevci.config.{ts,mts,js,mjs} in ${cwd} or a parent directory. Run \`jevci init\` to create one.`); }
    if (!existsSync(path)) { throw new JevciConfigError(`Config file not found: ${path}`); }
    // The config's own `import ... from '@hazymoon/jevci'` resolves to this copy, so a CI job can run
    // `npx @hazymoon/jevci` without installing the project's dependencies.
    const self = ['./index.mjs', './index.ts'].map(file => fileURLToPath(new URL(file, import.meta.url))).find(file => existsSync(file));
    let loaded: unknown;
    try {
        loaded = await createJiti(import.meta.url, { moduleCache: false, ...(self ? { alias: { '@hazymoon/jevci': self } } : {}) }).import(path, { default: true });
    } catch (err: unknown) {
        // `defineConfig` may come from another copy of this module, so match the error by name.
        if (err instanceof Error && err.name === 'JevciConfigError') { throw new JevciConfigError(`${path}:\n${err.message}`); }
        throw new JevciConfigError(`Could not load ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        return resolveConfig(loaded as JevciConfig, dirname(path), path);
    } catch (err: unknown) {
        throw err instanceof JevciConfigError ? new JevciConfigError(`${path}:\n${err.message}`) : err;
    }
}
