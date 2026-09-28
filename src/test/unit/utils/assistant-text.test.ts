import { describe, it, expect } from 'vitest';
import { extractAssistantText } from '../../../utils/assistant-text';

describe('extractAssistantText', () => {
    it('passes a plain string through', () => {
        expect(extractAssistantText('hello')).toBe('hello');
        expect(extractAssistantText('')).toBe('');
    });

    it('joins text blocks from an AssistantMessage', () => {
        const reply = {
            role: 'assistant',
            api: 'anthropic-messages',
            provider: 'anthropic',
            content: [
                { type: 'text', text: 'Fix the' },
                { type: 'thinking', thinking: 'must not appear' },
                { type: 'text', text: ' bug' },
                { type: 'tool_use', id: 't1', name: 'bash', input: {} },
            ],
            usage: {},
            stopReason: 'end_turn',
        };
        expect(extractAssistantText(reply)).toBe('Fix the\n bug');
    });

    it('returns empty when the model only emitted tool calls', () => {
        const reply = {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }],
        };
        expect(extractAssistantText(reply)).toBe('');
    });

    it('returns empty for null/undefined/non-content replies', () => {
        expect(extractAssistantText(null)).toBe('');
        expect(extractAssistantText(undefined)).toBe('');
        expect(extractAssistantText({})).toBe('');
        expect(extractAssistantText(42)).toBe('');
    });

    it('tolerates stray non-object blocks in content', () => {
        expect(extractAssistantText({ content: ['junk', null, { type: 'text', text: 'ok' }] })).toBe('ok');
    });
});