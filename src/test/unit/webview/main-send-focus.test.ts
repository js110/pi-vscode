// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

describe('composer focus after sending', () => {
    it('returns focus after clicking send for a prompt and a steering message', async () => {
        document.body.innerHTML = '<div id="app"></div>';
        const posted: any[] = [];
        const dispatch = (data: ServerMessage) => window.dispatchEvent(new MessageEvent('message', { data }));
        const sync = (isStreaming: boolean) => dispatch({ type: 'stateSync', state: { activeTabId: 't1', sessionId: 's1', messages: [], tools: [], isStreaming, supportsImages: true } });
        (window as any).acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => undefined, postMessage: (message: any) => {
            posted.push(message);
            if (message.type === 'getState') setTimeout(() => sync(false), 0);
        } });
        await import('../../../webview/main');
        await new Promise(resolve => setTimeout(resolve, 80));
        const input = document.getElementById('input') as HTMLTextAreaElement;
        dispatch({ type: 'selectionChanged', selection: { path: 'a.ts', startLine: 1, endLine: 1 }, focusComposer: true });
        expect(document.activeElement).toBe(input);
        const messages = document.getElementById('messages')!;
        const scrollTo = vi.spyOn(messages, 'scrollTo');
        scrollTo.mockClear();
        input.value = 'First message';
        const send = document.getElementById('btn-send') as HTMLButtonElement;
        send.focus();
        send.click();
        expect(posted.some(message => message.type === 'prompt' && message.text === 'First message')).toBe(true);
        expect(document.activeElement).toBe(input);
        dispatch({ type: 'agentEvent', event: { type: 'agent_start' } });
        dispatch({ type: 'agentEvent', event: { type: 'message_start', message: { role: 'assistant' } } });
        dispatch({ type: 'agentEvent', event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'reply' } } });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(scrollTo).not.toHaveBeenCalled();
        Object.defineProperty(messages, 'scrollHeight', { value: 1000, configurable: true });
        Object.defineProperty(messages, 'clientHeight', { value: 300, configurable: true });
        messages.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        messages.scrollTop = 700;
        messages.dispatchEvent(new Event('scroll'));
        dispatch({ type: 'agentEvent', event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' more' } } });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(scrollTo).toHaveBeenCalled();

        sync(true);
        input.value = 'Follow up';
        const streamingSend = document.getElementById('btn-send') as HTMLButtonElement;
        streamingSend.focus();
        streamingSend.click();
        expect(posted.some(message => message.type === 'steer' && message.text === 'Follow up')).toBe(true);
        expect(document.activeElement).toBe(input);
    });
});
