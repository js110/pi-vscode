import { describe, it, expect } from 'vitest';
import {
    parseUriList,
    uriToPath,
    relativeToWorkspace,
    isImagePath,
} from '../../../shared/drop-files';

describe('parseUriList', () => {
    it('splits multiple URIs', () => {
        expect(parseUriList('file:///a.ts\nfile:///b.ts')).toEqual([
            'file:///a.ts',
            'file:///b.ts',
        ]);
    });

    it('trims whitespace and drops blank lines and comments', () => {
        expect(parseUriList('  file:///a.ts  \r\n\r\n# comment\nfile:///b.ts'))
            .toEqual(['file:///a.ts', 'file:///b.ts']);
    });

    it('returns an empty list for empty input', () => {
        expect(parseUriList('')).toEqual([]);
    });
});

describe('uriToPath', () => {
    it('decodes posix file URIs', () => {
        expect(uriToPath('file:///home/u/a.ts')).toBe('/home/u/a.ts');
    });

    it('decodes windows drive URIs without the leading slash', () => {
        expect(uriToPath('file:///C:/Users/js/a.ts')).toBe('C:/Users/js/a.ts');
    });

    it('keeps UNC hosts as //server/share paths', () => {
        expect(uriToPath('file://srv/share/a.ts')).toBe('//srv/share/a.ts');
    });

    it('treats file://localhost like an empty authority', () => {
        expect(uriToPath('file://localhost/home/u/a.ts')).toBe('/home/u/a.ts');
    });

    it('decodes percent-escaped segments', () => {
        expect(uriToPath('file:///home/u/my%20file.ts')).toBe('/home/u/my file.ts');
    });

    it('rejects non-file schemes and malformed encoding', () => {
        expect(uriToPath('https://example.com/a.ts')).toBeNull();
        expect(uriToPath('file:///%zz.ts')).toBeNull();
    });
});

describe('relativeToWorkspace', () => {
    it('relativizes inside a root (windows separators)', () => {
        expect(relativeToWorkspace('C:\\proj\\src\\a.ts', ['C:/proj'])).toBe('src/a.ts');
    });

    it('relativizes inside a root (posix)', () => {
        expect(relativeToWorkspace('/home/u/proj/src/a.ts', ['/home/u/proj'])).toBe('src/a.ts');
    });

    it('matches case-insensitively but keeps the original casing', () => {
        expect(relativeToWorkspace('C:/Proj/SRC/a.ts', ['c:/proj'])).toBe('SRC/a.ts');
    });

    it('does not match a sibling directory that merely extends the root name', () => {
        expect(relativeToWorkspace('C:/projects/a.ts', ['C:/proj'])).toBeNull();
    });

    it('rejects traversal and dot segments instead of escaping the root', () => {
        expect(relativeToWorkspace('C:/proj/../secret.txt', ['C:/proj'])).toBeNull();
        expect(relativeToWorkspace('C:/proj/./a.ts', ['C:/proj'])).toBeNull();
    });

    it('tolerates trailing separators on the root', () => {
        expect(relativeToWorkspace('/w/a.ts', ['/w/'])).toBe('a.ts');
    });

    it('returns null outside every root', () => {
        expect(relativeToWorkspace('C:/other/a.ts', ['C:/proj'])).toBeNull();
        expect(relativeToWorkspace('/etc/passwd', ['C:/proj', '/home/u/proj'])).toBeNull();
    });

    it('returns null when the path is a root itself', () => {
        expect(relativeToWorkspace('C:/proj', ['C:/proj'])).toBeNull();
    });
});

describe('isImagePath', () => {
    it('detects image extensions case-insensitively', () => {
        expect(isImagePath('a/photo.PNG')).toBe(true);
        expect(isImagePath('logo.Svg')).toBe(true);
    });

    it('rejects non-image and extension-less paths', () => {
        expect(isImagePath('src/a.ts')).toBe(false);
        expect(isImagePath('README')).toBe(false);
    });
});
