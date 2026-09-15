import { describe, it, expect } from 'vitest';
import { computeLineDiff } from '../../../shared/line-diff';

describe('computeLineDiff', () => {
    it('returns all-added diff for a new file (empty old text)', () => {
        const r = computeLineDiff('', 'line1\nline2');
        expect(r.added).toBe(2);
        expect(r.removed).toBe(0);
        expect(r.diff.split('\n')).toEqual(['+line1', '+line2']);
    });

    it('returns all-removed diff when new text is empty', () => {
        const r = computeLineDiff('a\nb', '');
        expect(r.added).toBe(0);
        expect(r.removed).toBe(2);
        expect(r.diff.split('\n')).toEqual(['-a', '-b']);
    });

    it('returns empty diff for identical texts', () => {
        const r = computeLineDiff('same\nlines', 'same\nlines');
        expect(r.added).toBe(0);
        expect(r.removed).toBe(0);
        expect(r.diff).toBe('');
    });

    it('detects a replaced line as remove+add', () => {
        const r = computeLineDiff('const a = 1;\nconst b = 2;\nconst c = 3;', 'const a = 1;\nconst b = 22;\nconst c = 3;');
        expect(r.added).toBe(1);
        expect(r.removed).toBe(1);
        const lines = r.diff.split('\n');
        expect(lines).toContain('-const b = 2;');
        expect(lines).toContain('+const b = 22;');
        // unchanged context lines present with space prefix
        expect(lines).toContain(' const a = 1;');
        expect(lines).toContain(' const c = 3;');
    });

    it('handles inserted lines between context', () => {
        const r = computeLineDiff('a\nc', 'a\nb\nc');
        expect(r.added).toBe(1);
        expect(r.removed).toBe(0);
        expect(r.diff.split('\n')).toEqual([' a', '+b', ' c']);
    });

    it('handles trailing newline consistently (no phantom empty last line)', () => {
        const r = computeLineDiff('a\n', 'a\nb\n');
        expect(r.added).toBe(1);
        expect(r.removed).toBe(0);
        expect(r.diff.split('\n')).toEqual([' a', '+b']);
    });

    it('marks removals before additions within a changed block', () => {
        const r = computeLineDiff('old1\nold2', 'new1\nnew2');
        const lines = r.diff.split('\n');
        expect(lines).toEqual(['-old1', '-old2', '+new1', '+new2']);
    });

    it('falls back to a whole-block diff when the LCS table would be too large', () => {
        const n = 1100;
        const oldText = Array.from({ length: n }, (_, i) => `old${i}`).join('\n');
        const newText = Array.from({ length: n }, (_, i) => `new${i}`).join('\n');
        const r = computeLineDiff(oldText, newText);
        expect(r.added).toBe(n);
        expect(r.removed).toBe(n);
        expect(r.diff.split('\n')[0]).toBe('-old0');
    });

    it('returns an empty diff for identical large texts without building the table', () => {
        const n = 1100;
        const text = Array.from({ length: n }, (_, i) => `line${i}`).join('\n');
        const r = computeLineDiff(text, text);
        expect(r.added).toBe(0);
        expect(r.removed).toBe(0);
        expect(r.diff).toBe('');
    });
});
