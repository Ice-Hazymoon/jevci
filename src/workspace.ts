/**
 * Job paths from the workspace graph. A job that tests or builds some packages can be broken by a change
 * in any workspace package they depend on, directly or not, so its `paths` are those packages' directories
 * plus the directories of their dependency closure. Computed when the config loads, so the paths follow the
 * graph instead of drifting from it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { JevciConfigError } from './config.js';
import { matchesAny, matchesGlob } from './glob.js';

export interface WorkspacePackage {
    name: string;
    /** Directory relative to the workspace root, with `/` separators. */
    dir: string;
    /** Names of the workspace packages it depends on (any dependency field). */
    dependencies: string[];
    scripts: string[];
}

export interface Workspace {
    root: string;
    packages: Map<string, WorkspacePackage>;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function readJson(path: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
        return isObject(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

/** The `packages` globs of `pnpm-workspace.yaml`, or `workspaces` of `package.json` (npm, yarn, bun). */
function workspaceGlobs(dir: string): string[] | undefined {
    const pnpm = join(dir, 'pnpm-workspace.yaml');
    if (existsSync(pnpm)) {
        const document: unknown = parse(readFileSync(pnpm, 'utf8'));
        return isObject(document) && Array.isArray(document.packages) ? document.packages.map(String) : [];
    }
    const workspaces = readJson(join(dir, 'package.json'))?.workspaces;
    if (Array.isArray(workspaces)) { return workspaces.map(String); }
    if (isObject(workspaces) && Array.isArray(workspaces.packages)) { return workspaces.packages.map(String); }
    return undefined;
}

/** The nearest directory at or above `start` that declares workspaces. */
export function findWorkspaceRoot(start: string = process.cwd()): string | undefined {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
        if (workspaceGlobs(dir)) { return dir; }
        if (dirname(dir) === dir) { return undefined; }
    }
}

/** Directories under `root` matching the include globs and none of the `!` globs, no deeper than any glob reaches. */
function packageDirs(root: string, globs: readonly string[]): string[] {
    const clean = (glob: string): string => glob.replace(/^\.\//, '').replace(/\/$/, '');
    const include = globs.filter(glob => !glob.startsWith('!')).map(clean);
    const exclude = globs.filter(glob => glob.startsWith('!')).map(glob => clean(glob.slice(1)));
    const deep = include.some(glob => glob.includes('**'));
    const depth = Math.max(0, ...include.map(glob => glob.split('/').length));
    const found: string[] = [];
    const walk = (dir: string, level: number): void => {
        for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
            if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) { continue; }
            const path = dir ? `${dir}/${entry.name}` : entry.name;
            if (matchesAny(include, path) && !matchesAny(exclude, path) && existsSync(join(root, path, 'package.json'))) { found.push(path); }
            if (deep || level + 1 < depth) { walk(path, level + 1); }
        }
    };
    walk('', 0);
    return found;
}

/** Every package of the workspace at or above `start`. Throws `JevciConfigError` when there is none. */
export function readWorkspace(start: string = process.cwd()): Workspace {
    const root = findWorkspaceRoot(start);
    if (!root) { throw new JevciConfigError(`No pnpm-workspace.yaml or package.json "workspaces" in ${resolve(start)} or a parent directory.`); }
    const manifests = packageDirs(root, workspaceGlobs(root) ?? []).flatMap((dir) => {
        const manifest = readJson(join(root, dir, 'package.json'));
        return typeof manifest?.name === 'string' ? [{ dir, manifest, name: manifest.name }] : [];
    });
    const names = new Set(manifests.map(({ name }) => name));
    const packages = new Map<string, WorkspacePackage>();
    for (const { dir, manifest, name } of manifests) {
        const dependencies = DEPENDENCY_FIELDS.flatMap(field => (isObject(manifest[field]) ? Object.keys(manifest[field]) : [])).filter(dep => names.has(dep) && dep !== name);
        const scripts = isObject(manifest.scripts) ? Object.keys(manifest.scripts) : [];
        packages.set(name, { name, dir: relative(root, join(root, dir)).split('\\').join('/'), dependencies: [...new Set(dependencies)], scripts });
    }
    return { root, packages };
}

/** Package names matching `patterns` (exact names or globs such as `@scope/*`); an unmatched pattern is a config error. */
function selectPackages(workspace: Workspace, patterns: readonly string[]): string[] {
    const all = [...workspace.packages.keys()];
    const unmatched = patterns.filter(pattern => !all.some(name => matchesGlob(name, pattern)));
    if (unmatched.length) { throw new JevciConfigError(`workspacePaths: no workspace package matches ${unmatched.map(name => `"${name}"`).join(', ')}.`); }
    return all.filter(name => patterns.some(pattern => matchesGlob(name, pattern)));
}

/** `names` and every workspace package they depend on, transitively. */
export function dependencyClosure(workspace: Workspace, names: readonly string[]): string[] {
    const seen = new Set<string>();
    const visit = (name: string): void => {
        if (seen.has(name)) { return; }
        seen.add(name);
        for (const dep of workspace.packages.get(name)?.dependencies ?? []) { visit(dep); }
    };
    names.forEach(visit);
    return [...seen];
}

export interface WorkspacePathsOptions {
    /** Where to look for the workspace root. Default: the current directory. */
    cwd?: string;
    /** A workspace already read by `readWorkspace`, to share one read between jobs. */
    workspace?: Workspace;
}

/**
 * `<dir>/**` for each selected package and each workspace package it depends on, transitively, as paths
 * relative to the workspace root. Put it in a job's `paths`; add anything else the job reads (root config,
 * files its tests open by path) yourself.
 */
export function workspacePaths(packages: readonly string[], options: WorkspacePathsOptions = {}): string[] {
    const workspace = options.workspace ?? readWorkspace(options.cwd);
    const closure = dependencyClosure(workspace, selectPackages(workspace, packages));
    return [...new Set(closure.map(name => workspace.packages.get(name)!.dir))].sort().map(dir => (dir ? `${dir}/**` : '**'));
}
