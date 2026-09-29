/**
 * Deterministic evidence for Jev: text a change removes, and which test files still contain it.
 * A test that asserts copy the change rewrites is the usual way a "harmless" edit turns a job red.
 */
import { filesContaining } from './git.js';

export interface Evidence {
    /** Removed text and the test files at head that still contain it. */
    testsContainingRemovedText: Array<{ text: string; files: string[] }>;
    /** Removed text no test file contains. */
    removedTextNotInTests: string[];
}

const QUOTED = /'((?:[^'\\\n]|\\.){3,120})'|"((?:[^"\\\n]|\\.){3,120})"|`([^`$\n]{3,120})`/g;
const MARKUP_TEXT = />([^<>{}\n]{4,120})</g;
const IDENTIFIER = /\b[A-Z_$][\w$]{5,}\b/gi;
const TEXT_LIMIT = 10;
const FILES_PER_TEXT = 5;

function linesOf(diff: string, sign: '-' | '+'): string[] {
    return diff.split('\n').filter(line => line.startsWith(sign)).map(line => line.slice(1));
}

/** String literals, markup text and identifiers on removed lines that no added line keeps. */
export function removedTexts(diff: string, limit: number = TEXT_LIMIT): string[] {
    const removed = linesOf(diff, '-').join('\n');
    const added = linesOf(diff, '+').join('\n');
    const found = new Set<string>();
    const keep = (text: string | undefined): void => {
        const trimmed = text?.trim();
        if (trimmed && trimmed.length >= 3 && !added.includes(trimmed)) { found.add(trimmed); }
    };
    for (const match of removed.matchAll(QUOTED)) { keep(match[1] ?? match[2] ?? match[3]); }
    for (const match of removed.matchAll(MARKUP_TEXT)) { keep(match[1]); }
    for (const match of removed.matchAll(IDENTIFIER)) { keep(match[0]); }
    return [...found].slice(0, limit);
}

/** Looks up each removed text in the test files at `rev`. */
export function collectEvidence(root: string, rev: string, diff: string, testFiles: readonly string[]): Evidence {
    const evidence: Evidence = { testsContainingRemovedText: [], removedTextNotInTests: [] };
    if (testFiles.length === 0) { return evidence; }
    for (const text of removedTexts(diff)) {
        const files = filesContaining(root, rev, text, testFiles);
        if (files.length) {
            evidence.testsContainingRemovedText.push({ text, files: files.slice(0, FILES_PER_TEXT) });
        } else {
            evidence.removedTextNotInTests.push(text);
        }
    }
    return evidence;
}
