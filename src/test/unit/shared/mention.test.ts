import { describe, it, expect } from 'vitest';
import {
    parseMentionToken,
    fuzzyFilterFiles,
    hasMentionToken,
    stripMentions,
    buildMentionContext,
    fenceFor,
    truncateMentionContent,
    extractLines,
    MAX_MENTION_RESULTS,
    MAX_MENTION_FILE_CHARS,
    MENTION_CONTEXT_WINDOW_LINES,
} from '../../../shared/mention';

describe('parseMentionToken', () => {
    it('parses a plain relative path', () => {
        expect(parseMentionToken('src/a.ts')).toEqual({ path: 'src/a.ts', line: undefined });
    });

    it('normalizes backslashes to posix separators', () => {
        expect(parseMentionToken('src\\a.ts')).toEqual({ path: 'src/a.ts', line: undefined });
    });

    it('parses a path with a 1-based line', () => {
        expect(parseMentionToken('src/a.ts:42')).toEqual({ path: 'src/a.ts', line: 42 });
    });

    it('rejects traversal, absolute paths, and malformed lines', () => {
        expect(parseMentionToken('../secrets')).toBeNull();
        expect(parseMentionToken('a/../../b')).toBeNull();
        expect(parseMentionToken('/etc/passwd')).toBeNull();
        expect(parseMentionToken('src/a.ts:0')).toBeNull();
        expect(parseMentionToken('src/a.ts:x')).toBeNull();
        expect(parseMentionToken(':42')).toBeNull();
        expect(parseMentionToken('')).toBeNull();
    });
});

describe('fuzzyFilterFiles', () => {
    const FILES = [
        'src/providers/tab.ts',
        'src/shared/protocol.ts',
        'src/webview/main.ts',
        'prd/task-list.md',
    ];

    it('returns the first N paths for an empty query', () => {
        expect(fuzzyFilterFiles(FILES, '', 3)).toHaveLength(3);
        expect(fuzzyFilterFiles(FILES, '', MAX_MENTION_RESULTS)).toEqual(FILES);
    });

    it('matches subsequences case-insensitively', () => {
        expect(fuzzyFilterFiles(FILES, 'tl', 10)).toContain('prd/task-list.md');
        expect(fuzzyFilterFiles(FILES, 'tb', 10)).toContain('src/providers/tab.ts');
    });

    it('drops paths without a subsequence match', () => {
        expect(fuzzyFilterFiles(FILES, 'zzz', 10)).toEqual([]);
    });

    it('prefers shorter paths and boundary hits', () => {
        const ranked = fuzzyFilterFiles(
            ['a/bb/cc/tab.ts', 'tab.ts', 'src/ttt/ab.ts'],
            'tab',
            10,
        );
        expect(ranked[0]).toBe('tab.ts');
    });

    it('respects the limit', () => {
        const many = Array.from({ length: 40 }, (_, i) => `dir${i}/match.ts`);
        expect(fuzzyFilterFiles(many, 'match', 5)).toHaveLength(5);
    });
});

describe('stripMentions', () => {
    it('removes a token and one trailing space', () => {
        expect(stripMentions('look at @gone.ts please', ['gone.ts'])).toBe(
            'look at please',
        );
    });

    it('removes a token at the end of the text', () => {
        expect(stripMentions('look at @gone.ts', ['gone.ts'])).toBe('look at');
    });

    it('removes multiple tokens', () => {
        expect(stripMentions('@a.ts and @b.ts', ['a.ts', 'b.ts'])).toBe('and');
    });

    it('leaves text without the tokens untouched', () => {
        expect(stripMentions('plain text', ['gone.ts'])).toBe('plain text');
    });

    it('does not strip a sibling symbol token that merely starts with the token', () => {
        expect(stripMentions('see @a.ts:42 now', ['a.ts'])).toBe('see @a.ts:42 now');
    });
});

describe('hasMentionToken', () => {
    it('matches a whole token followed by whitespace or end', () => {
        expect(hasMentionToken('look at @a.ts now', 'a.ts')).toBe(true);
        expect(hasMentionToken('look at @a.ts', 'a.ts')).toBe(true);
    });

    it('does not match a prefix inside a longer symbol token', () => {
        expect(hasMentionToken('explain @a.ts:42', 'a.ts')).toBe(false);
        expect(hasMentionToken('@a.ts-extra stuff', 'a.ts')).toBe(false);
    });

    it('matches at the start of the text', () => {
        expect(hasMentionToken('@a.ts please', 'a.ts')).toBe(true);
    });
});

describe('buildMentionContext', () => {
    it('returns empty string with no entries', () => {
        expect(buildMentionContext([])).toBe('');
    });

    it('appends a fenced block per entry with the extension as language', () => {
        const text = buildMentionContext([
            { token: 'src/a.ts', ref: { path: 'src/a.ts', line: undefined }, content: 'const a = 1;' },
        ]);
        expect(text).toContain('\n\n@src/a.ts:\n```ts\nconst a = 1;\n```');
    });

    it('joins multiple entries', () => {
        const text = buildMentionContext([
            { token: 'a.ts', ref: { path: 'a.ts', line: undefined }, content: 'A' },
            { token: 'b.py', ref: { path: 'b.py', line: undefined }, content: 'B' },
        ]);
        expect(text).toContain('```ts\nA\n```');
        expect(text).toContain('```py\nB\n```');
    });

    it('lengthens the fence when the content contains backtick runs', () => {
        const text = buildMentionContext([
            { token: 'a.md', ref: { path: 'a.md', line: undefined }, content: '```js\nvar x = 1\n```' },
        ]);
        expect(text).toContain('````md\n```js\nvar x = 1\n```\n````');
    });
});

describe('fenceFor', () => {
    it('uses three backticks for plain content', () => {
        expect(fenceFor('const a = 1;')).toBe('```');
    });

    it('out-runs the longest backtick run at line starts', () => {
        expect(fenceFor('```js\nvar x = 1\n```')).toBe('````');
        expect(fenceFor('````\ntext\n````')).toBe('`````');
    });
});

describe('truncateMentionContent', () => {
    it('keeps content within the cap unchanged', () => {
        const small = 'x'.repeat(100);
        expect(truncateMentionContent(small, MAX_MENTION_FILE_CHARS)).toBe(small);
    });

    it('truncates oversized content with a note', () => {
        const big = 'y'.repeat(MAX_MENTION_FILE_CHARS + 10);
        const out = truncateMentionContent(big, MAX_MENTION_FILE_CHARS);
        expect(out.length).toBeLessThanOrEqual(MAX_MENTION_FILE_CHARS + 50);
        expect(out).toContain('[truncated]');
    });
});

describe('extractLines', () => {
    const FILE = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');

    it('slices a window around the given 1-based line', () => {
        expect(extractLines(FILE, 3, 2)).toBe('l3\nl4');
    });

    it('clamps to the file bounds', () => {
        expect(extractLines(FILE, 1, 2)).toBe('l1\nl2');
        expect(extractLines(FILE, 99, 2)).toBe('l5');
        expect(extractLines(FILE, 3, 5)).toBe('l2\nl3\nl4\nl5');
    });
});
