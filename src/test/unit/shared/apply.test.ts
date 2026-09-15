import { describe, it, expect } from 'vitest';
import { langToExtensions, rankCandidates, newFileName } from '../../../shared/apply';

describe('langToExtensions', () => {
    it('maps common languages', () => {
        expect(langToExtensions('typescript')).toEqual(['ts', 'tsx']);
        expect(langToExtensions('ts')).toEqual(['ts', 'tsx']);
        expect(langToExtensions('js')).toEqual(['js', 'jsx', 'mjs', 'cjs']);
        expect(langToExtensions('python')).toEqual(['py']);
        expect(langToExtensions('json')).toEqual(['json']);
        expect(langToExtensions('css')).toEqual(['css']);
        expect(langToExtensions('html')).toEqual(['html', 'htm']);
    });

    it('is case-insensitive and tolerant of unknown languages', () => {
        expect(langToExtensions('TypeScript')).toEqual(['ts', 'tsx']);
        expect(langToExtensions('')).toEqual([]);
        expect(langToExtensions('obscurelang')).toEqual([]);
    });
});

describe('rankCandidates', () => {
    it('keeps only files with matching extensions', () => {
        const files = [
            '/w/src/a.ts',
            '/w/readme.md',
            '/w/src/b.tsx',
            '/w/style.css',
        ];
        expect(rankCandidates(files, ['ts', 'tsx'])).toEqual(['/w/src/a.ts', '/w/src/b.tsx']);
    });

    it('sorts shallower paths first, then alphabetically', () => {
        const files = [
            '/w/deep/nested/dir/z.ts',
            '/w/b.ts',
            '/w/src/a.ts',
        ];
        expect(rankCandidates(files, ['ts'])).toEqual(['/w/b.ts', '/w/src/a.ts', '/w/deep/nested/dir/z.ts']);
    });

    it('returns empty array when nothing matches', () => {
        expect(rankCandidates(['/w/a.md'], ['ts'])).toEqual([]);
    });
});

describe('newFileName', () => {
    it('uses the first extension and a timestamp suffix', () => {
        const name = newFileName('py', new Date('2026-09-15T12:00:00'));
        expect(name).toMatch(/^pi-apply-\d{6}\.py$/);
        expect(name.endsWith('py')).toBe(true);
    });

    it('falls back to txt for empty extension', () => {
        const name = newFileName('', new Date('2026-09-15T12:00:00'));
        expect(name).toMatch(/^pi-apply-\d{6}\.txt$/);
    });
});
