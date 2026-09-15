import { describe, it, expect } from 'vitest';
import { computeUnifiedDiff } from '../../../utils/diff';

describe('computeUnifiedDiff', () => {
    it('diffs two texts with no common lines (Myers backtrack regression)', () => {
        const { diff, stats } = computeUnifiedDiff('A\n', 'B\n', 'f.ts');
        expect(stats).toEqual({ added: 1, removed: 1 });
        // Phantom empty lines / +0 hunk starts were symptoms of the bug.
        expect(diff.split('\n')).toEqual([
            '--- a/f.ts',
            '+++ b/f.ts',
            '@@ -1,1 +1,1 @@',
            '-A',
            '+B',
        ]);
    });

    it('handles an insert with no common lines and differing lengths', () => {
        const { diff, stats } = computeUnifiedDiff('A\n', 'B\nC\n', 'f.ts');
        expect(stats).toEqual({ added: 2, removed: 1 });
        expect(diff.split('\n').slice(2)).toEqual([
            '@@ -1,1 +1,2 @@',
            '-A',
            '+B',
            '+C',
        ]);
    });

    it('keeps common context around a mid-file edit', () => {
        const { diff, stats } = computeUnifiedDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n', 'f.ts');
        expect(stats).toEqual({ added: 1, removed: 1 });
        expect(diff.split('\n').slice(2)).toEqual([
            '@@ -1,3 +1,3 @@',
            ' one',
            '-two',
            '+TWO',
            ' three',
        ]);
    });

    it('returns an empty diff for identical texts', () => {
        const { diff, stats } = computeUnifiedDiff('same\n', 'same\n', 'f.ts');
        expect(diff).toBe('');
        expect(stats).toEqual({ added: 0, removed: 0 });
    });
});
