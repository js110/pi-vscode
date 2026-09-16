import { describe, it, expect } from 'vitest';
import {
    stripAnsi,
    truncateTerminalOutput,
    formatTerminalQuote,
    TERMINAL_OUTPUT_MAX_CHARS,
    type TerminalOutputEntry,
} from '../../../shared/terminal-quote';

describe('stripAnsi', () => {
    it('removes SGR color sequences', () => {
        expect(stripAnsi('\x1b[31merror\x1b[0m plain')).toBe('error plain');
    });

    it('removes cursor movement and erase sequences', () => {
        expect(stripAnsi('\x1b[2J\x1b[Hclear')).toBe('clear');
        expect(stripAnsi('\x1b[?25lblink\x1b[?25h')).toBe('blink');
    });

    it('removes OSC sequences (window title, hyperlinks)', () => {
        expect(stripAnsi('\x1b]0;my title\x07done')).toBe('done');
        expect(stripAnsi('\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
    });

    it('removes standalone control chars but keeps newlines', () => {
        expect(stripAnsi('a\bb\x07c\nd')).toBe('abc\nd');
    });

    it('emulates carriage-return overwrites (progress bars)', () => {
        // '10%' overwritten from column 0 by '20%', then by '100%'
        expect(stripAnsi('10%\r20%\r100%')).toBe('100%');
        // Overwrite shorter than existing content leaves the tail intact
        expect(stripAnsi('abc\rX')).toBe('Xbc');
        // A trailing \r without following content keeps the line
        expect(stripAnsi('done\r')).toBe('done');
        // CRLF is normalized to \n
        expect(stripAnsi('a\r\nb')).toBe('a\nb');
    });
});

describe('truncateTerminalOutput', () => {
    it('keeps short output unchanged', () => {
        expect(truncateTerminalOutput('short', 100)).toBe('short');
    });

    it('keeps the tail of oversized output with an explicit marker', () => {
        const text = 'a'.repeat(120) + 'tail-end';
        const out = truncateTerminalOutput(text, 100);
        expect(out.length).toBeLessThanOrEqual(100 + '[... 15 characters truncated ...]\n'.length);
        expect(out.endsWith('tail-end')).toBe(true);
        expect(out).toContain('truncated');
    });

    it('exposes the production cap as a sane constant', () => {
        expect(TERMINAL_OUTPUT_MAX_CHARS).toBe(8000);
    });
});

describe('formatTerminalQuote', () => {
    it('wraps command and output in a fenced block', () => {
        const entry: TerminalOutputEntry = {
            command: 'npm test',
            output: 'all green',
            terminalName: 'bash',
        };
        const formatted = formatTerminalQuote(entry);
        expect(formatted).toContain('```text');
        expect(formatted).toContain('$ npm test');
        expect(formatted).toContain('all green');
        expect(formatted.trimEnd().endsWith('```')).toBe(true);
    });

    it('mentions the terminal name', () => {
        const entry: TerminalOutputEntry = {
            command: 'ls',
            output: 'a.ts',
            terminalName: 'pwsh',
        };
        expect(formatTerminalQuote(entry)).toContain('pwsh');
    });

    it('lengthens the fence when the output itself contains backtick fences', () => {
        const entry: TerminalOutputEntry = {
            command: 'cat md',
            output: 'intro\n```js\nvar x = 1;\n```\nend',
            terminalName: 'bash',
        };
        const formatted = formatTerminalQuote(entry);
        expect(formatted.startsWith('````text')).toBe(true);
        expect(formatted.trimEnd().endsWith('````')).toBe(true);
    });

    it('notes empty output explicitly', () => {
        const entry: TerminalOutputEntry = {
            command: 'echo',
            output: '',
            terminalName: 'bash',
        };
        const formatted = formatTerminalQuote(entry);
        expect(formatted).toContain('(no output)');
    });
});
