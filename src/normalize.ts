import type { JevciNormalizer } from './config.js';
/**
 * Comment- and format-only change detection. A normalizer strips what no CI job can observe (comments,
 * layout); two versions of a file that normalize to the same string differ in no way that matters.
 *
 * Scripts are compared as syntax trees through the TypeScript parser, so `//` inside a string, regex or
 * template literal is never mistaken for a comment. Comments that tools read (the `directives`:
 * `@ts-expect-error`, `eslint-disable`, `#__PURE__`, JSDoc types) stay in, so editing one is a real change.
 * The parser is jevci's own TypeScript 6 dependency, whatever version the project uses: TypeScript 7 has no
 * JavaScript parser API.
 * Every normalizer returns `undefined` when it cannot be sure, and the change then counts as real.
 */
import type TypeScript from 'typescript';
import { createRequire } from 'node:module';
import { matchesAny } from './glob.js';

let typescript: typeof TypeScript | null | undefined;

/** Loaded on first use, since most plans compare no script; `undefined` when it cannot be loaded. */
function loadTypeScript(): typeof TypeScript | undefined {
    if (typescript === undefined) {
        try {
            const loaded = createRequire(import.meta.url)('typescript') as typeof TypeScript;
            typescript = typeof loaded.createSourceFile === 'function' ? loaded : null;
        } catch {
            typescript = null;
        }
    }
    return typescript ?? undefined;
}

const COMMENT = /\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g;

function scriptKind(ts: typeof TypeScript, path: string): TypeScript.ScriptKind {
    if (/\.[cm]?tsx$/.test(path)) { return ts.ScriptKind.TSX; }
    if (/\.jsx$/.test(path)) { return ts.ScriptKind.JSX; }
    return /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** Walks a parsed script, collecting the canonical token stream and the directive comments. */
class ScriptWriter {
    readonly tokens: string[] = [];
    readonly directives: string[] = [];

    constructor(private readonly ts: typeof TypeScript, private readonly file: TypeScript.SourceFile, private readonly pattern: RegExp) {}

    visit(node: TypeScript.Node, lastInList: boolean): void {
        const { ts } = this;
        const children = node.getChildren(this.file).filter(child => child.kind < ts.SyntaxKind.FirstJSDocNode || child.kind > ts.SyntaxKind.LastJSDocNode);
        if (children.length === 0) {
            this.leaf(node, lastInList);
            return;
        }
        this.tokens.push(`(${node.kind}`);
        const list = node.kind === ts.SyntaxKind.SyntaxList;
        children.forEach((child, index) => this.visit(child, list && index === children.length - 1));
        this.tokens.push(')');
    }

    /** A leaf token. The trivia before it holds the comments; semicolons and trailing commas carry no meaning here. */
    private leaf(node: TypeScript.Node, lastInList: boolean): void {
        const { ts, file } = this;
        const comments = file.text.slice(node.pos, node.getStart(file)).match(COMMENT) ?? [];
        this.directives.push(...comments.filter(comment => this.pattern.test(comment)).map(comment => comment.replace(/\s+/g, ' ')));
        const dropped = node.kind === ts.SyntaxKind.SemicolonToken || node.kind === ts.SyntaxKind.EndOfFileToken || (node.kind === ts.SyntaxKind.CommaToken && lastInList);
        if (dropped) { return; }
        if (ts.isStringLiteral(node)) {
            this.tokens.push(JSON.stringify(node.text));
        } else {
            this.tokens.push(node.kind === ts.SyntaxKind.JsxText ? file.text.slice(node.pos, node.end) : node.getText(file));
        }
    }
}

/**
 * A script as nested node kinds around its leaf tokens: layout, comments, quote style, semicolons and
 * trailing commas drop out, while any change in structure stays (`a\n(b)` is a call, `a;(b)` is not).
 */
export function normalizeScript(text: string, path: string, directives: RegExp): string | undefined {
    const ts = loadTypeScript();
    if (!ts) { return undefined; }
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(ts, path));
    const diagnostics = (file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
    if (!Array.isArray(diagnostics) || diagnostics.length > 0) { return undefined; }
    const writer = new ScriptWriter(ts, file, directives);
    writer.visit(file, false);
    const tokens = writer.tokens.join(' ');
    return writer.directives.length ? `${tokens}\n/* directives */\n${writer.directives.join('\n')}` : tokens;
}

/** HTML-like text: comments that are not directives removed, whitespace runs collapsed. */
export function normalizeMarkup(text: string, directives: RegExp): string {
    return text.replace(/<!--[\s\S]*?-->/g, comment => (directives.test(comment) ? comment : ' ')).replace(/\s+/g, ' ').trim();
}

/** CSS and its dialects: block comments that are not directives removed, whitespace runs collapsed. */
export function normalizeCss(text: string, directives: RegExp): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, comment => (directives.test(comment) ? comment : ' ')).replace(/\s+/g, ' ').trim();
}

/** JSON compared by value; anything that does not parse falls back to `normalizeText`. */
export function normalizeJson(text: string): string {
    try {
        return JSON.stringify(JSON.parse(text));
    } catch {
        return normalizeText(text);
    }
}

/** Unknown formats: line endings and trailing whitespace only, since indentation and comments can be syntax. */
export function normalizeText(text: string): string {
    return text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trimEnd();
}

/**
 * A Vue single-file component: each `<script>` by its `lang`, each `<style>` as CSS, the rest (template,
 * custom blocks) as markup. Template whitespace is collapsed, as Vue's compiler condenses it by default.
 */
export function normalizeVue(text: string, directives: RegExp): string | undefined {
    const parts: string[] = [];
    let rest = text;
    for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
        const attrs = match[1] ?? '';
        const lang = /\blang=["']?(\w+)/.exec(attrs)?.[1] ?? 'js';
        const script = normalizeScript(match[2] ?? '', `block.${lang}`, directives);
        if (script === undefined) { return undefined; }
        parts.push(`<script ${attrs.replace(/\s+/g, ' ').trim()}>${script}</script>`);
        rest = rest.replace(match[0], '');
    }
    for (const match of text.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/g)) {
        parts.push(`<style ${(match[1] ?? '').replace(/\s+/g, ' ').trim()}>${normalizeCss(match[2] ?? '', directives)}</style>`);
        rest = rest.replace(match[0], '');
    }
    parts.push(normalizeMarkup(rest, directives));
    return parts.join('\n');
}

const BUILT_IN: ReadonlyArray<{ files: readonly string[]; normalize: (text: string, path: string, directives: RegExp) => string | undefined }> = [
    { files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'], normalize: normalizeScript },
    { files: ['**/*.vue'], normalize: (text, _path, directives) => normalizeVue(text, directives) },
    { files: ['**/*.json'], normalize: text => normalizeJson(text) },
    { files: ['**/*.{html,htm,svg,xml}'], normalize: (text, _path, directives) => normalizeMarkup(text, directives) },
    { files: ['**/*.{css,scss,sass,less,pcss,postcss}'], normalize: (text, _path, directives) => normalizeCss(text, directives) },
];

export interface NormalizeOptions {
    directives: RegExp;
    normalizers?: readonly JevciNormalizer[];
}

/** `text` as the file at `path` with comments and layout removed, or undefined when that cannot be done safely. */
export function normalize(path: string, text: string, options: NormalizeOptions): string | undefined {
    const custom = options.normalizers?.find(normalizer => matchesAny(normalizer.files, path));
    const builtIn = BUILT_IN.find(normalizer => matchesAny(normalizer.files, path));
    try {
        if (custom) { return custom.normalize(text, path); }
        return builtIn ? builtIn.normalize(text, path, options.directives) : normalizeText(text);
    } catch {
        // A normalizer that throws is unsure: the change counts as real.
        return undefined;
    }
}
