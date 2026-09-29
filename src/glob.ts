/**
 * Glob matching over repository paths. Unlike `path.matchesGlob`, wildcards match dotfiles and dot
 * directories too: `**` must cover `.github/` and `.gitignore`, or a config that means "everything"
 * silently leaves them out and their jobs never run.
 *
 * `*` any characters within a segment, `**` any number of whole segments, `?` one character,
 * `{a,b}` alternatives, `[abc]` / `[!abc]` a character class. Patterns match the whole path.
 */

/** A translated piece of a glob: its regex source and how many glob characters it consumed. */
type TPiece = [source: string, length: number];

const cache = new Map<string, RegExp>();

function star(glob: string, at: number): TPiece {
    if (glob[at + 1] !== '*') { return ['[^/]*', 1]; }
    const wholeSegment = at === 0 || glob[at - 1] === '/';
    if (wholeSegment && at + 2 === glob.length) { return ['.*', 2]; }
    if (wholeSegment && glob[at + 2] === '/') { return ['(?:[^/]*/)*', 3]; }
    return ['[^/]*', 2];
}

function alternatives(glob: string, at: number): TPiece {
    const close = glob.indexOf('}', at);
    if (close === -1) { return ['\\{', 1]; }
    return [`(?:${glob.slice(at + 1, close).split(',').map(translate).join('|')})`, close - at + 1];
}

function characterClass(glob: string, at: number): TPiece {
    const close = glob.indexOf(']', at + 1);
    if (close === -1) { return ['\\[', 1]; }
    const body = glob.slice(at + 1, close);
    return [`[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`, close - at + 1];
}

function piece(glob: string, at: number): TPiece {
    const char = glob[at]!;
    switch (char) {
        case '*': return star(glob, at);
        case '?': return ['[^/]', 1];
        case '{': return alternatives(glob, at);
        case '[': return characterClass(glob, at);
        default: return [/[\\^$.+()|/\]}]/.test(char) ? `\\${char}` : char, 1];
    }
}

function translate(glob: string): string {
    let source = '';
    for (let at = 0; at < glob.length;) {
        const [part, length] = piece(glob, at);
        source += part;
        at += length;
    }
    return source;
}

export function globToRegExp(glob: string): RegExp {
    let regex = cache.get(glob);
    if (!regex) {
        regex = new RegExp(`^${translate(glob)}$`);
        cache.set(glob, regex);
    }
    return regex;
}

export function matchesGlob(path: string, glob: string): boolean {
    return globToRegExp(glob).test(path);
}

export function matchesAny(globs: readonly string[], path: string): boolean {
    return globs.some(glob => matchesGlob(path, glob));
}
