import { describe, it, expect } from 'vitest';
import { splitStreamBlocks, computeUnchangedPrefix } from '../../../shared/stream-blocks';

describe('splitStreamBlocks', () => {
    it('splits paragraphs on blank lines', () => {
        expect(splitStreamBlocks('para one\n\npara two')).toEqual(['para one', 'para two']);
    });

    it('keeps fenced code blocks intact even with blank lines inside', () => {
        const text = 'intro\n\n```py\nline1\n\nline2\n```\n\nafter';
        expect(splitStreamBlocks(text)).toEqual(['intro', '```py\nline1\n\nline2\n```', 'after']);
    });

    it('treats an unterminated fence as one growing block', () => {
        const text = 'text\n\n```js\nconst a;';
        expect(splitStreamBlocks(text)).toEqual(['text', '```js\nconst a;']);
    });

    it('supports tilde fences', () => {
        const text = 'a\n\n~~~\ncode\n~~~\n\nb';
        expect(splitStreamBlocks(text)).toEqual(['a', '~~~\ncode\n~~~', 'b']);
    });

    it('returns a single block when there are no blank lines', () => {
        expect(splitStreamBlocks('one\ntwo\nthree')).toEqual(['one\ntwo\nthree']);
    });

    it('drops whitespace-only chunks and tolerates multiple blank lines', () => {
        expect(splitStreamBlocks('a\n\n\n\nb\n\n')).toEqual(['a', 'b']);
        expect(splitStreamBlocks('')).toEqual([]);
        expect(splitStreamBlocks('   \n\n  ')).toEqual([]);
    });

    it('keeps 4-backtick fences intact when 3-backtick lines appear inside', () => {
        const text = 'x\n\n````\ncode\n```\n\nmore\n````\n\ny';
        expect(splitStreamBlocks(text)).toEqual(['x', '````\ncode\n```\n\nmore\n````', 'y']);
    });

    it('treats a closer with an info string as fence content (CommonMark)', () => {
        const text = '```js\nfoo\n``` js\nbar\n```';
        expect(splitStreamBlocks(text)).toEqual(['```js\nfoo\n``` js\nbar\n```']);
    });

    it('requires the closer to be at least as long as the opener', () => {
        const text = '````\nkeep\n```\nstill keep\n````\n\nafter';
        expect(splitStreamBlocks(text)).toEqual(['````\nkeep\n```\nstill keep\n````', 'after']);
    });

    it('preserves the indent of indented code blocks', () => {
        expect(splitStreamBlocks('para\n\n    indented code')).toEqual(['para', '    indented code']);
    });
});

describe('computeUnchangedPrefix', () => {
    it('counts identical leading blocks', () => {
        expect(computeUnchangedPrefix(['a', 'b', 'c'], ['a', 'b2', 'c'])).toBe(1);
        expect(computeUnchangedPrefix(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(2);
    });

    it('returns 0 when nothing matches and full length for identical arrays', () => {
        expect(computeUnchangedPrefix(['x'], ['y'])).toBe(0);
        expect(computeUnchangedPrefix([], ['a'])).toBe(0);
        expect(computeUnchangedPrefix(['a', 'b'], ['a', 'b'])).toBe(2);
        expect(computeUnchangedPrefix(['a'], [])).toBe(0);
    });

    it('handles streaming growth: all but the volatile tail stay unchanged', () => {
        const prev = splitStreamBlocks('# Title\n\nSome intro text');
        const next = splitStreamBlocks('# Title\n\nSome intro text and more words');
        expect(computeUnchangedPrefix(prev, next)).toBe(1);
    });
});
