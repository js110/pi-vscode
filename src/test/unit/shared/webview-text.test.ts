import { describe, it, expect } from 'vitest';
import {
    escAttr,
    formatTimestamp,
    formatTokenCount,
    formatTokensCompact,
    truncate,
    tryParseJSON,
    extractText,
    extractThinking,
    extractToolResultText,
    formatToolArgs,
    buildStatusHtml,
    getToolIcon,
    getToolLabel,
    getFileIcon,
    renderDiffLines,
} from '../../../shared/webview-text';

describe('webview-text', () => {
    it('escAttr escapes & " < >', () => {
        expect(escAttr(`a&b"c<d>e`)).toBe('a&amp;b&quot;c&lt;d&gt;e');
    });

    it('formatTimestamp handles seconds and ms', () => {
        expect(formatTimestamp(0)).toBe('');
        expect(formatTimestamp(undefined)).toBe('');
        const sec = 1600000000;
        const ms = sec * 1000;
        expect(formatTimestamp(sec)).toBe(formatTimestamp(ms));
    });

    it('formatTokenCount compresses large counts', () => {
        expect(formatTokenCount(500)).toBe('500');
        expect(formatTokenCount(1500)).toBe('1.5k');
        expect(formatTokenCount(1500000)).toBe('1.5M');
    });

    it('formatTokensCompact matches status-bar formatting', () => {
        expect(formatTokensCompact(-1)).toBe('0');
        expect(formatTokensCompact(950)).toBe('950');
        expect(formatTokensCompact(9500)).toBe('9.5k');
        expect(formatTokensCompact(950000)).toBe('950k');
        expect(formatTokensCompact(9500000)).toBe('9.5M');
    });

    it('truncate appends ellipsis only past max', () => {
        expect(truncate('abc', 5)).toBe('abc');
        expect(truncate('abcdef', 3)).toBe('abc...');
    });

    it('tryParseJSON parses or returns input', () => {
        expect(tryParseJSON('{"a":1}')).toEqual({ a: 1 });
        expect(tryParseJSON('not json')).toBe('not json');
    });

    it('extractText handles string, array, and text forms', () => {
        expect(extractText({ content: 'hi' })).toBe('hi');
        expect(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'x' }] })).toBe('a');
        expect(extractText({ text: 'fallback' })).toBe('fallback');
    });

    it('extractThinking pulls thinking blocks', () => {
        expect(extractThinking({ content: [{ type: 'thinking', thinking: 'think' }] })).toBe('think');
        expect(extractThinking({ thinking: 'direct' })).toBe('direct');
    });

    it('extractToolResultText handles strings, arrays, objects', () => {
        expect(extractToolResultText('plain')).toBe('plain');
        expect(extractToolResultText([{ text: 'a' }, 'b'])).toBe('a\nb');
        expect(extractToolResultText({ content: [{ text: 'x' }] })).toBe('x');
        expect(extractToolResultText({ output: 'o' })).toBe('o');
        expect(extractToolResultText(undefined)).toBe('');
        expect(extractToolResultText({ a: 1 })).toContain('"a"');
    });

    it('formatToolArgs flattens object args', () => {
        expect(formatToolArgs({ command: 'ls', cwd: '/tmp' })).toBe('command: ls\ncwd: /tmp');
        expect(formatToolArgs({ nested: { a: 1 } })).toBe('nested: {"a":1}');
        expect(formatToolArgs(null)).toBe('');
    });

    it('buildStatusHtml is empty for done', () => {
        expect(buildStatusHtml('done')).toBe('');
        expect(buildStatusHtml('running')).toContain('tool-status running');
    });

    it('getToolIcon returns an svg for known and unknown tools', () => {
        expect(getToolIcon('BASH')).toContain('<svg');
        expect(getToolIcon('unknown')).toContain('<svg');
    });

    it('getToolLabel maps known tools and truncates args', () => {
        expect(getToolLabel('bash', { command: 'ls' })).toBe('ls');
        expect(getToolLabel('read', {})).toBe('Read file');
        expect(getToolLabel('other', {})).toBe('other');
    });

    it('getFileIcon falls back to generic file icon', () => {
        expect(getFileIcon('a.ts')).toContain('312');
        expect(getFileIcon('a.xyz')).toContain('196');
    });

    it('renderDiffLines omits ---/+++ and classifies lines', () => {
        const html = renderDiffLines('--- a\n+++ b\n@@ -1 +1 @@\n+add\n-del\n ctx');
        expect(html).not.toContain('diff-line-hunk">---');
        expect(html).toContain('diff-line-hunk');
        expect(html).toContain('diff-line-add');
        expect(html).toContain('diff-line-del');
        expect(html).toContain('diff-line-ctx');
    });
});
