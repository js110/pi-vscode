import { describe, it, expect } from 'vitest';
import { parseChangedLineRanges } from '../../../shared/inline-diff';

describe('parseChangedLineRanges', () => {
    it('returns empty for an empty diff', () => {
        expect(parseChangedLineRanges('')).toEqual([]);
    });

    it('extracts a single added block with 0-based conversion', () => {
        const diff = [
            '--- a/f.ts',
            '+++ b/f.ts',
            '@@ -1,3 +1,4 @@',
            ' one',
            '+inserted',
            '+inserted2',
            ' two',
        ].join('\n');
        // newStart=1 → 0-based line 0; two added lines then context.
        expect(parseChangedLineRanges(diff)).toEqual([{ start: 1, end: 2 }]);
    });

    it('splits ranges on context gaps', () => {
        const diff = [
            '--- a/f.ts',
            '+++ b/f.ts',
            '@@ -1,5 +1,6 @@',
            ' a',
            '+x',
            ' b',
            ' c',
            '+y',
            ' d',
        ].join('\n');
        expect(parseChangedLineRanges(diff)).toEqual([
            { start: 1, end: 1 },
            { start: 4, end: 4 },
        ]);
    });

    it('merges adjacent added lines across a hunk body continuation', () => {
        const diff = [
            '--- a/f.ts',
            '+++ b/f.ts',
            '@@ -1,2 +1,4 @@',
            ' a',
            '+x',
            '+y',
            '+z',
        ].join('\n');
        expect(parseChangedLineRanges(diff)).toEqual([{ start: 1, end: 3 }]);
    });

    it('ignores deletions (no new-file position)', () => {
        const diff = [
            '--- a/f.ts',
            '+++ b/f.ts',
            '@@ -1,3 +1,2 @@',
            ' a',
            '-gone',
            '-also gone',
            ' b',
        ].join('\n');
        expect(parseChangedLineRanges(diff)).toEqual([]);
    });

    it('handles a pure-deletion hunk with zero new count', () => {
        const diff = [
            '--- a/f.ts',
            '+++ b/f.ts',
            '@@ -3,2 +2,0 @@',
            '-x',
            '-y',
        ].join('\n');
        expect(parseChangedLineRanges(diff)).toEqual([]);
    });

    it('does not count file headers as added lines', () => {
        const diff = [
            '--- a/+++weird',
            '+++ b/+++weird',
            '@@ -0,0 +1,1 @@',
            '+real add',
        ].join('\n');
        expect(parseChangedLineRanges(diff)).toEqual([{ start: 0, end: 0 }]);
    });

    it('counts added lines whose content starts with ++ (not file headers)', () => {
        const diff = [
            '--- a/f.ts',
            '+++ b/f.ts',
            '@@ -1,1 +1,2 @@',
            ' a',
            '+++md',
        ].join('\n');
        expect(parseChangedLineRanges(diff)).toEqual([{ start: 1, end: 1 }]);
    });

    it('supports hunk headers without counts', () => {
        const diff = [
            '--- a/f.ts',
            '+++ b/f.ts',
            '@@ -2 +2 @@',
            '-old',
            '+new',
        ].join('\n');
        expect(parseChangedLineRanges(diff)).toEqual([{ start: 1, end: 1 }]);
    });

    it('tracks positions across multiple hunks', () => {
        const diff = [
            '--- a/f.ts',
            '+++ b/f.ts',
            '@@ -1,2 +1,3 @@',
            ' a',
            '+x',
            ' b',
            '@@ -10,2 +12,2 @@',
            ' c',
            '+y',
        ].join('\n');
        // Second hunk newStart=12 → 0-based 11 is context, 12 is added.
        expect(parseChangedLineRanges(diff)).toEqual([
            { start: 1, end: 1 },
            { start: 12, end: 12 },
        ]);
    });
});
