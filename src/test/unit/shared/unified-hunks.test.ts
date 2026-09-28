import { describe, it, expect } from 'vitest';

import {
    parseUnifiedHunks,
    applyHunkSelection,
    applyHunkSelectionToNew,
} from '../../../shared/unified-hunks';

const ORIGINAL = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
const NEW = [
    '0', '1', 'TWO', '3', '4', '5', '6', '7', 'eight', '9',
].join('\n');

// Matches the unified format produced by `computeUnifiedDiff` (diff.test.ts):
// the hunk `oldStart,oldCount` span covers context + changed lines, and the
// body's old lines map sequentially onto that span.
const TWO_HUNK_DIFF = [
    '--- a/f.ts',
    '+++ b/f.ts',
    '@@ -2,3 +2,3 @@',
    ' 1',
    '-2',
    '+TWO',
    ' 3',
    '@@ -8,3 +8,3 @@',
    ' 7',
    '-8',
    '+eight',
    ' 9',
].join('\n');

describe('parseUnifiedHunks', () => {
    it('parses each hunk with old coordinates and body lines', () => {
        const { hunks, skipped } = parseUnifiedHunks(TWO_HUNK_DIFF);
        expect(skipped).toBe(0);
        expect(hunks).toHaveLength(2);
        expect(hunks[0]).toEqual({
            oldStart: 2,
            oldCount: 3,
            lines: [' 1', '-2', '+TWO', ' 3'],
        });
        expect(hunks[1]).toEqual({
            oldStart: 8,
            oldCount: 3,
            lines: [' 7', '-8', '+eight', ' 9'],
        });
    });

    it('ignores the ---/+++ file-header lines', () => {
        const { hunks } = parseUnifiedHunks('--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,1 @@\n-A\n+B');
        expect(hunks).toHaveLength(1);
        expect(hunks[0].lines).toEqual(['-A', '+B']);
    });

    it('tolerates junk around malformed headers', () => {
        const { hunks, skipped } = parseUnifiedHunks('@@ -1,1 +1,1 @@\ngarbage\n-X\n+Y');
        expect(skipped).toBeGreaterThanOrEqual(1);
        expect(hunks).toHaveLength(1);
    });

    it('returns no hunks for an empty diff', () => {
        expect(parseUnifiedHunks('').hunks).toHaveLength(0);
    });
});

describe('applyHunkSelection', () => {
    it('applying every hunk rebuilds the full new content', () => {
        const { hunks } = parseUnifiedHunks(TWO_HUNK_DIFF);
        const all = applyHunkSelection(ORIGINAL, hunks, new Set([0, 1]));
        expect(all).toBe(NEW);
    });

    it('applying no hunks leaves the file untouched', () => {
        const { hunks } = parseUnifiedHunks(TWO_HUNK_DIFF);
        expect(applyHunkSelection(ORIGINAL, hunks, new Set())).toBe(ORIGINAL);
    });

    it('applies only the first hunk, leaving the second edit in place', () => {
        const { hunks } = parseUnifiedHunks(TWO_HUNK_DIFF);
        const result = applyHunkSelection(ORIGINAL, hunks, new Set([0]));
        expect(result).toBe(['0', '1', 'TWO', '3', '4', '5', '6', '7', '8', '9'].join('\n'));
    });

    it('applies only the second hunk, reverting the first edit', () => {
        const { hunks } = parseUnifiedHunks(TWO_HUNK_DIFF);
        const result = applyHunkSelection(ORIGINAL, hunks, new Set([1]));
        expect(result).toBe(['0', '1', '2', '3', '4', '5', '6', '7', 'eight', '9'].join('\n'));
    });

    it('drops `\\ No newline` diff markers instead of writing them into the file', () => {
        // Original is 'x\na' without a trailing newline; removing line 2 ('a')
        // and replacing it with 'b' keeps the no-newline marker out of content.
        const diff = '@@ -2,1 +2,1 @@\n-a\n+b\n\\ No newline at end of file';
        const { hunks } = parseUnifiedHunks(diff);
        const result = applyHunkSelection('x\na', hunks, new Set([0]));
        expect(result).toBe('x\nb');
    });
});

describe('applyHunkSelectionToNew', () => {
    it('keeps only the added lines of the selected hunks', () => {
        const { hunks } = parseUnifiedHunks(TWO_HUNK_DIFF);
        expect(applyHunkSelectionToNew(hunks, new Set([0]))).toBe('TWO');
        expect(applyHunkSelectionToNew(hunks, new Set([0, 1]))).toBe('TWO\neight');
    });
});