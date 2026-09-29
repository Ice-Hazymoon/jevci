/**
 * Read-only git access: the change set between two commits and file contents on either side.
 */
import { execFileSync } from 'node:child_process';

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

/**
 * Text of many `rev:path` blobs in one `git cat-file --batch` call; a missing, non-blob or binary entry
 * maps to undefined.
 */
export function textsAt(root: string, specs: readonly string[]): Map<string, string | undefined> {
    const texts = new Map<string, string | undefined>();
    if (specs.length === 0) { return texts; }
    const out = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: `${specs.join('\n')}\n`, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] });
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
    return texts;
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

/** Paths at `rev` matching `globs` whose content contains `text` literally. */
export function filesContaining(root: string, rev: string, text: string, globs: readonly string[]): string[] {
    try {
        const out = git(root, ['grep', '-l', '-F', '-e', text, rev, '--', ...globs.map(glob => `:(glob)${glob}`)]);
        return out.split('\n').filter(Boolean).map(line => line.slice(rev.length + 1));
    } catch {
        return [];
    }
}
