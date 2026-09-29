/**
 * Read-only git access: the change set between two commits and file contents on either side.
 */
import { execFile, execFileSync } from 'node:child_process';
import { matchesAny } from './glob.js';

export type TChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';

export interface ChangedFile {
    path: string;
    /** The path before a rename or copy. */
    oldPath?: string;
    status: TChangeStatus;
    binary: boolean;
}

/** The base or head commit cannot be used (all-zero `before`, force-push, shallow clone). */
export class JevciRangeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JevciRangeError';
    }
}

const STATUS: Record<string, TChangeStatus> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type-changed' };

export function git(root: string, args: readonly string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
}

function commitExists(root: string, rev: string): boolean {
    try {
        git(root, ['cat-file', '-e', `${rev}^{commit}`]);
        return true;
    } catch {
        return false;
    }
}

/** Resolves `base`/`head` to commit SHAs and diffs from their merge base, like a pull request does. */
export function resolveRange(root: string, base: string, head: string): { base: string; head: string } {
    if (/^0+$/.test(base)) { throw new JevciRangeError('base is the all-zero SHA (a new branch or tag push); there is nothing to diff against.'); }
    for (const [name, rev] of [['base', base], ['head', head]] as const) {
        if (!commitExists(root, rev)) { throw new JevciRangeError(`${name} ${rev} is not a commit in this clone (shallow checkout or force-push); fetch full history.`); }
    }
    let mergeBase: string;
    try {
        mergeBase = git(root, ['merge-base', base, head]).trim();
    } catch {
        throw new JevciRangeError(`${base} and ${head} share no history.`);
    }
    return { base: mergeBase, head: git(root, ['rev-parse', head]).trim() };
}

export function changedFiles(root: string, base: string, head: string): ChangedFile[] {
    const nameStatus = git(root, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', base, head]).split('\0').filter(Boolean);
    const binary = new Set<string>();
    for (const line of git(root, ['diff', '--numstat', '-z', '-M', '--no-ext-diff', base, head]).split('\0')) {
        const match = /^-\t-\t(.*)$/.exec(line);
        if (match?.[1]) { binary.add(match[1]); }
    }
    const files: ChangedFile[] = [];
    for (let i = 0; i < nameStatus.length;) {
        const code = nameStatus[i++]!;
        const status = STATUS[code[0]!] ?? 'modified';
        if (status === 'renamed' || status === 'copied') {
            const oldPath = nameStatus[i++]!;
            const path = nameStatus[i++]!;
            files.push({ path, oldPath, status, binary: binary.has(path) });
        } else {
            const path = nameStatus[i++]!;
            files.push({ path, status, binary: binary.has(path) });
        }
    }
    return files;
}

/** Blobs above this are never compared as text: a generated file or snapshot that size is a real change. */
export const MAX_TEXT_BYTES = 1 << 20;
const BATCH_BYTES = 64 << 20;

/** `rev:path` specs that name a blob no larger than `limit`, with their sizes. */
function smallBlobs(root: string, specs: readonly string[], limit: number): Array<[spec: string, size: number]> {
    const out = execFileSync('git', ['cat-file', '--batch-check'], { cwd: root, input: `${specs.join('\n')}\n`, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = out.split('\n');
    return specs.flatMap((spec, index): Array<[string, number]> => {
        const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(lines[index] ?? '');
        return match?.[1] === 'blob' && Number(match[2]) <= limit ? [[spec, Number(match[2])]] : [];
    });
}

/**
 * Text of many `rev:path` blobs through `git cat-file --batch`, in batches of bounded size; a missing,
 * non-blob, binary or oversized (over `limit` bytes) entry maps to undefined.
 */
export function textsAt(root: string, specs: readonly string[], limit: number = MAX_TEXT_BYTES): Map<string, string | undefined> {
    const texts = new Map<string, string | undefined>(specs.map(spec => [spec, undefined]));
    if (specs.length === 0) { return texts; }
    const batches: string[][] = [];
    let total = BATCH_BYTES;
    for (const [spec, size] of smallBlobs(root, specs, limit)) {
        if (total + size > BATCH_BYTES) {
            batches.push([]);
            total = 0;
        }
        batches.at(-1)!.push(spec);
        total += size;
    }
    for (const batch of batches) { readBatch(root, batch, texts); }
    return texts;
}

function readBatch(root: string, specs: readonly string[], texts: Map<string, string | undefined>): void {
    const out = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: `${specs.join('\n')}\n`, maxBuffer: BATCH_BYTES + (1 << 20), stdio: ['pipe', 'pipe', 'ignore'] });
    let offset = 0;
    for (const spec of specs) {
        const newline = out.indexOf(10, offset);
        const header = out.subarray(offset, newline).toString('utf8');
        offset = newline + 1;
        const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (!match) {
            texts.set(spec, undefined);
            continue;
        }
        const size = Number(match[2]);
        const bytes = out.subarray(offset, offset + size);
        offset += size + 1;
        texts.set(spec, match[1] === 'blob' && !bytes.includes(0) ? bytes.toString('utf8') : undefined);
    }
}

/** Unified diff of one file with three lines of context, header lines dropped. */
export function fileDiff(root: string, base: string, head: string, file: Pick<ChangedFile, 'path' | 'oldPath'>): string {
    const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
    const out = git(root, ['diff', '-U3', '--no-color', '--no-ext-diff', '-M', base, head, '--', ...paths]);
    return out.split('\n').filter(line => !/^(?:diff --git|index |--- |\+\+\+ |similarity index|rename (?:from|to) |new file mode|deleted file mode|old mode|new mode)/.test(line)).join('\n').trim();
}

/** Full messages of the commits in `base..head`. */
export function commitMessages(root: string, base: string, head: string): string[] {
    return git(root, ['log', '--format=%B%x00', `${base}..${head}`]).split('\0').map(message => message.trim()).filter(Boolean);
}

/** The promisor remote of a partial (e.g. `--filter=blob:none`) clone, or undefined in a full clone. */
function promisorRemote(root: string): string | undefined {
    const read = (args: readonly string[]): string => {
        try {
            return git(root, ['config', ...args]).trim();
        } catch {
            return '';
        }
    };
    const flagged = /^remote\.(.+)\.promisor true$/m.exec(read(['--get-regexp', '^remote\\..*\\.promisor$']))?.[1];
    return flagged ?? (read(['--get', 'extensions.partialClone']) || undefined);
}

/**
 * In a partial clone, fetches the blobs at `rev` matching `globs` that are not local yet, in one request.
 * `git grep <rev>` would otherwise fetch them one request per blob. A no-op in a full clone.
 */
export function prefetchBlobs(root: string, rev: string, globs: readonly string[]): void {
    const remote = promisorRemote(root);
    if (!remote || globs.length === 0) { return; }
    const entries = git(root, ['ls-tree', '-r', '-z', rev]).split('\0').flatMap((line) => {
        const match = /^\d+ blob ([0-9a-f]+)\t(.*)$/s.exec(line);
        return match && matchesAny(globs, match[2]!) ? [match[1]!] : [];
    });
    if (entries.length === 0) { return; }
    const status = execFileSync('git', ['cat-file', '--batch-check=%(objectname)'], { cwd: root, input: `${entries.join('\n')}\n`, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const missing = status.split('\n').filter(line => line.endsWith(' missing')).map(line => line.slice(0, -' missing'.length));
    if (missing.length === 0) { return; }
    try {
        execFileSync('git', ['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', remote, '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', '--stdin'], { cwd: root, input: `${missing.join('\n')}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
        // `git grep` fetches what is still missing on its own.
    }
}

/** For each of `texts`, the paths at `rev` matching `globs` that contain it literally, searched `concurrency` at a time. */
export async function filesContainingEach(root: string, rev: string, texts: readonly string[], globs: readonly string[], concurrency: number = 8): Promise<Map<string, string[]>> {
    const unique = [...new Set(texts)];
    const found = new Map<string, string[]>();
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < unique.length) {
            const text = unique[next++]!;
            found.set(text, await grepFiles(root, rev, text, globs));
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
    return found;
}

function grepFiles(root: string, rev: string, text: string, globs: readonly string[]): Promise<string[]> {
    return new Promise((resolve) => {
        execFile('git', ['grep', '-l', '-F', '-e', text, rev, '--', ...globs.map(glob => `:(glob)${glob}`)], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }, (err, out) => {
            // Exit status 1 means no match; any other failure also yields no evidence.
            resolve(err ? [] : out.split('\n').filter(Boolean).map(line => line.slice(rev.length + 1)));
        });
    });
}

/** Paths at `rev` matching `globs` whose content contains `text` literally. */
export function filesContaining(root: string, rev: string, text: string, globs: readonly string[]): string[] {
    try {
        const out = git(root, ['grep', '-l', '-F', '-e', text, rev, '--', ...globs.map(glob => `:(glob)${glob}`)]);
        return out.split('\n').filter(Boolean).map(line => line.slice(rev.length + 1));
    } catch {
        return [];
    }
}
