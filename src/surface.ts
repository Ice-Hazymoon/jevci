/**
 * A module's export surface. Removing or renaming an export breaks every importer, which no single-file
 * judgement can see, so such an edit runs all of the file's jobs by rule.
 */
const SCRIPT = /\.[cm]?[jt]sx?$/;
const DECLARATION = /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Z_$][\w$]*)/i;
const LIST = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/;
const DEFAULT = /^\s*export\s+default\b/;

/** Names exported by these lines: declarations, `export { a as b }` lists and `export default`. */
export function exportedNames(lines: readonly string[]): Set<string> {
    const names = new Set<string>();
    for (const line of lines) {
        const declared = DECLARATION.exec(line)?.[1];
        if (declared) { names.add(declared); }
        if (DEFAULT.test(line)) { names.add('default'); }
        for (const part of LIST.exec(line)?.[1]?.split(',') ?? []) {
            const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '');
            if (name) { names.add(name); }
        }
    }
    return names;
}

/** Exports in `before` that `after` no longer has, for a script file; empty for other files. */
export function removedExports(path: string, before: readonly string[], after: readonly string[]): string[] {
    if (!SCRIPT.test(path)) { return []; }
    const kept = exportedNames(after);
    return [...exportedNames(before)].filter(name => !kept.has(name));
}
