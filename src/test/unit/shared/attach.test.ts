import { describe, it, expect } from 'vitest';
import {
    looksBinary,
    normalizeAttachContent,
    buildAttachContext,
    splitAttachments,
    MAX_ATTACH_CHARS,
    type AttachFileEntry,
} from '../../../shared/attach';

describe('splitAttachments', () => {
    it('separates webview-read content from host-read paths', () => {
        const { contents, paths } = splitAttachments([
            { name: 'pasted.txt', content: 'read in webview' },
            { name: 'picked.py', path: '/workspace/picked.py' },
        ]);
        expect(contents).toEqual([{ name: 'pasted.txt', content: 'read in webview' }]);
        expect(paths).toEqual(['/workspace/picked.py']);
    });

    it('prefers content when both are present', () => {
        const { contents, paths } = splitAttachments([{ name: 'a.txt', path: '/x/a.txt', content: 'cached' }]);
        expect(contents).toEqual([{ name: 'a.txt', content: 'cached' }]);
        expect(paths).toEqual([]);
    });
});

describe('looksBinary', () => {
    it('flags NUL bytes in the sample as binary', () => {
        const text = new TextEncoder().encode('hello');
        const bin = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]);
        expect(looksBinary(bin.buffer)).toBe(true);
        expect(looksBinary(text)).toBe(false);
    });

    it('returns false for empty input', () => {
        expect(looksBinary(new Uint8Array(0))).toBe(false);
    });
});

describe('normalizeAttachContent', () => {
    it('keeps content within the cap untouched', () => {
        expect(normalizeAttachContent('abc')).toBe('abc');
    });

    it('truncates oversized content with a note', () => {
        const big = 'x'.repeat(MAX_ATTACH_CHARS + 10);
        const out = normalizeAttachContent(big);
        expect(out.length).toBe(MAX_ATTACH_CHARS + '\n[truncated]'.length);
        expect(out.endsWith('[truncated]')).toBe(true);
    });
});

describe('buildAttachContext', () => {
    it('builds a fenced block per attachment with the language hint', () => {
        const out = buildAttachContext([{ name: 'a.py', content: 'print(1)' }]);
        expect(out).toContain('[Attached file: a.py]');
        expect(out).toContain('```py');
        expect(out).toContain('print(1)');
    });

    it('returns an empty string for no attachments', () => {
        expect(buildAttachContext([])).toBe('');
    });

    it('skips whitespace-only attachments', () => {
        expect(buildAttachContext([{ name: 'a.md', content: '   \n  ' }])).toBe('');
    });

    it('out-runs any backtick run inside the content', () => {
        const out = buildAttachContext([{ name: 'a.md', content: '```\ncode\n```' }]);
        expect(out).toContain('````');
    });

    it('appends one block per attachment in order', () => {
        const entries: AttachFileEntry[] = [
            { name: 'a.ts', content: '1' },
            { name: 'b.json', content: '{}' },
        ];
        const out = buildAttachContext(entries);
        expect(out.indexOf('a.ts')).toBeLessThan(out.indexOf('b.json'));
    });
});