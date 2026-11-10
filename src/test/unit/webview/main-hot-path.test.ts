// @vitest-environment happy-dom
//
// Regression guards for the webview hot-path fixes:
//  - document-level listeners must be bound once, not once per render()
//    (a tab switch / language change re-runs render());
//  - switching display language must keep the composer draft;
//  - an idle stateSync must not rebuild the composer footer or clobber a
//    queued-message edit in progress.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

const posted: any[] = [];

function dispatch(m: ServerMessage): void {
    window.dispatchEvent(new MessageEvent('message', { data: m }));
}

function stateSync(over: Record<string, unknown> = {}): ServerMessage {
    return {
        type: 'stateSync',
        state: {
            sessionId: 's1',
            sessionName: 'HotPath',
            activeTabId: 't1',
            tabs: [
                { id: 't1', name: 'One', isActive: true, isStreaming: false, hasNotification: false },
                { id: 't2', name: 'Two', isActive: false, isStreaming: false, hasNotification: false },
            ],
            messages: MESSAGES,
            tools: [],
            isStreaming: false,
            contextUsage: { tokens: 1000, contextWindow: 200000, percent: 1 },
            ...over,
        },
    } as ServerMessage;
}

const pause = () => new Promise(resolve => setTimeout(resolve, 10));

const MESSAGES = [
    { role: 'user', content: 'hello there', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'transcript text to copy and mark' }], timestamp: 2 },
];

beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    (window as any).acquireVsCodeApi = () => ({
        getState: () => undefined,
        setState: () => undefined,
        postMessage: (message: any) => {
            posted.push(message);
            if (message.type === 'getState') setTimeout(() => dispatch(stateSync()), 0);
        },
    });
    await import('../../../webview/main');
    await pause();
});

beforeEach(() => {
    posted.length = 0;
});

describe('webview hot path', () => {
    it('keeps the composer draft when the display language changes', async () => {
        const input = document.getElementById('input') as HTMLTextAreaElement;
        input.value = 'draft I am still writing';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        dispatch({ type: 'langChanged', lang: 'zh' } as ServerMessage);
        await pause();

        const next = document.getElementById('input') as HTMLTextAreaElement;
        expect(next).not.toBe(input);
        expect(next.value).toBe('draft I am still writing');
    });

    it('leaves a queued-message edit intact across an unrelated stateSync', async () => {
        dispatch(stateSync({
            isStreaming: true,
            queuedMessages: [{ text: 'follow up later', kind: 'followUp' }],
        }));
        await pause();

        const editBtn = document.querySelector<HTMLButtonElement>('.queued-item-edit');
        expect(editBtn).not.toBeNull();
        editBtn!.click();

        const editInput = document.querySelector<HTMLInputElement>('.queued-edit-input');
        expect(editInput).not.toBeNull();
        editInput!.value = 'edited while streaming';
        editInput!.focus();

        // Context usage moves: the footer's rendered output does not.
        dispatch(stateSync({
            isStreaming: true,
            queuedMessages: [{ text: 'follow up later', kind: 'followUp' }],
            contextUsage: { tokens: 5000, contextWindow: 200000, percent: 3 },
        }));
        await pause();

        const after = document.querySelector<HTMLInputElement>('.queued-edit-input');
        expect(after).not.toBeNull();
        expect(after!.value).toBe('edited while streaming');
    });
});
