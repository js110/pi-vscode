import { describe, it, expect } from 'vitest';
import { buildSessionMarkdown, suggestedExportFileName } from '../../../shared/session-export';

const EXPORTED_AT = Date.UTC(2026, 8, 18, 10, 30, 0);

function textMessage(role: string, text: string, extra: Record<string, unknown> = {}) {
    return { role, content: [{ type: 'text', text }], ...extra };
}

describe('buildSessionMarkdown', () => {
    it('emits a title, metadata block, and role sections', () => {
        const md = buildSessionMarkdown(
            [textMessage('user', 'hello'), textMessage('assistant', 'hi there')],
            { name: 'Refactor login', model: 'Claude Sonnet 5', exportedAtMs: EXPORTED_AT },
        );
        expect(md).toContain('# Refactor login');
        expect(md).toContain('- Model: Claude Sonnet 5');
        expect(md).toContain('- Exported: 2026-09-18T10:30:00.000Z');
        expect(md).toContain('## User');
        expect(md).toContain('hello');
        expect(md).toContain('## Assistant');
        expect(md).toContain('hi there');
    });

    it('falls back to a default title when the session is unnamed', () => {
        const md = buildSessionMarkdown([textMessage('user', 'x')], { exportedAtMs: EXPORTED_AT });
        expect(md).toContain('# Pi session');
    });

    it('renders string content as-is', () => {
        const md = buildSessionMarkdown(
            [{ role: 'user', content: 'plain string' }],
            { exportedAtMs: EXPORTED_AT },
        );
        expect(md).toContain('plain string');
    });

    it('wraps assistant thinking parts in a collapsible block before the answer', () => {
        const md = buildSessionMarkdown(
            [{
                role: 'assistant',
                content: [
                    { type: 'thinking', text: 'secret plan' },
                    { type: 'text', text: 'the answer' },
                ],
            }],
            { exportedAtMs: EXPORTED_AT },
        );
        const thinkingIdx = md.indexOf('<details>');
        const summaryIdx = md.indexOf('<summary>Thinking</summary>');
        const planIdx = md.indexOf('secret plan');
        const answerIdx = md.indexOf('the answer');
        expect(summaryIdx).toBeGreaterThan(thinkingIdx);
        expect(planIdx).toBeGreaterThan(summaryIdx);
        expect(answerIdx).toBeGreaterThan(planIdx);
        expect(md).toContain('</details>');
    });

    it('notes image attachments on user messages', () => {
        const md = buildSessionMarkdown(
            [{
                role: 'user',
                content: [
                    { type: 'image', assetId: 'img-1' },
                    { type: 'text', text: 'what is this?' },
                ],
            }],
            { exportedAtMs: EXPORTED_AT },
        );
        expect(md).toContain('[image attachment]');
        expect(md).toContain('what is this?');
    });

    it('renders tool results with name, error state, and a safe fence', () => {
        const tricky = 'output with ```js\nnested fence\n``` inside';
        const md = buildSessionMarkdown(
            [
                textMessage('assistant', 'running'),
                { role: 'toolResult', toolName: 'bash', content: tricky },
                { role: 'toolResult', toolName: 'read', isError: true, content: 'boom' },
            ],
            { exportedAtMs: EXPORTED_AT },
        );
        expect(md).toContain('## Tool: bash');
        expect(md).toContain('## Tool: read (error)');
        expect(md).toContain(tricky);
        // The inner ``` must not terminate the outer fence: the outer fence
        // is longer than any backtick run in the content.
        expect(md).toContain('````');
    });

    it('shows a placeholder for empty tool output', () => {
        const md = buildSessionMarkdown(
            [{ role: 'toolResult', toolName: 'bash', content: '' }],
            { exportedAtMs: EXPORTED_AT },
        );
        expect(md).toContain('## Tool: bash');
        expect(md).toContain('(no output)');
    });

    it('skips assistant messages without text or thinking', () => {
        const md = buildSessionMarkdown(
            [
                textMessage('user', 'go'),
                { role: 'assistant', content: [{ type: 'toolCall', id: 't1' }] },
                textMessage('assistant', 'done'),
            ],
            { exportedAtMs: EXPORTED_AT },
        );
        expect(md.match(/## Assistant/g)).toHaveLength(1);
    });
});

describe('suggestedExportFileName', () => {
    it('sanitizes the session name and appends a UTC date stamp', () => {
        expect(suggestedExportFileName('fix: login & oauth? flow', EXPORTED_AT))
            .toBe('fix-login-oauth-flow-2026-09-18.md');
    });

    it('falls back to pi-session for an empty name', () => {
        expect(suggestedExportFileName('   ', EXPORTED_AT)).toBe('pi-session-2026-09-18.md');
    });

    it('caps a very long name', () => {
        const name = 'x'.repeat(200);
        const file = suggestedExportFileName(name, EXPORTED_AT);
        expect(file.length).toBeLessThan(80);
        expect(file.endsWith('-2026-09-18.md')).toBe(true);
    });
});
