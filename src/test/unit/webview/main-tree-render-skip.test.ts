// @vitest-environment happy-dom
//
// Exercises the REAL chat webview bootstrap (src/webview/main.ts) inside
// happy-dom with a mock `acquireVsCodeApi`. Guards the tree-render skip:
// updateMessages() rebuilds the whole message tree, which destroys the
// user's text selection (select text → idle stateSync lands → ⌘C copies
// nothing) and any hover/flash state on the old nodes. An idle frame that
// changes no tree input must leave the DOM alone; a frame that ships a new
// messages array must rebuild.
//
// main.ts installs a `window` message listener on import and ESM caches the
// module, so the harness boots once in beforeAll.

import { describe, it, expect, beforeAll } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

function dispatch(m: ServerMessage): void {
    window.dispatchEvent(new MessageEvent('message', { data: m }));
}

const MESSAGES = [
    { role: 'user', content: 'hello there', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'first reply' }], timestamp: 2 },
];

function stateSync(overrides: Record<string, unknown> = {}): ServerMessage {
    return {
        type: 'stateSync',
        state: {
            sessionId: 's1',
            sessionName: 'Skip',
            activeTabId: 't1',
            tabs: [{ id: 't1', name: 'Skip', isActive: true, isStreaming: false, hasNotification: false }],
            messages: MESSAGES,
            isStreaming: false,
            tools: [],
            model: { provider: 'anthropic', id: 'claude-smoke', name: 'Claude Smoke' },
            supportsImages: true,
            ...overrides,
        },
        images: {},
    } as unknown as ServerMessage;
}

async function nextFrame(): Promise<void> {
    await new Promise((r) => setTimeout(r, 40));
}

beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const api = {
        postMessage: (m: any) => {
            if (m.type === 'getState') setTimeout(() => dispatch(stateSync()), 0);
            if (m.type === 'getSkills') setTimeout(() => dispatch({ type: 'skills', skills: [] } as ServerMessage), 0);
        },
        getState: () => undefined,
        setState: () => undefined,
    };
    (window as unknown as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => api;
    await import('../../../webview/main');
    await nextFrame();
    await nextFrame();
});

describe('message tree render skip', () => {
    it('keeps the built tree (and a live selection) across an idle stateSync frame', async () => {
        const before = document.querySelector('.message-user');
        expect(before?.textContent).toContain('hello there');

        // User selects part of the reply…
        const selected = (() => {
            const assistant = [...document.querySelectorAll('.message-group-assistant .message-content p')][0];
            const firstChild = assistant?.firstChild;
            if (!firstChild) return '';
            const range = document.createRange();
            range.setStart(firstChild, 0);
            range.setEnd(firstChild, 5);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return selection?.toString() ?? '';
        })();
        expect(selected).toBe('first');

        // …an idle frame lands (cosmetic change only: same messages reference,
        // same counts — the T16 shape the host sends while a turn is quiet)…
        dispatch(stateSync({ sessionName: 'Skip (renamed)' }));
        await nextFrame();
        await nextFrame();

        // …the tree must be the SAME nodes, not a rebuild…
        expect(document.querySelector('.message-user')).toBe(before);
        // …and the selection must still be alive for ⌘C.
        expect(window.getSelection()?.toString()).toBe('first');
    });

    it('rebuilds when the host ships a new messages array', async () => {
        const before = document.querySelector('.message-user');
        const grown = [...MESSAGES, { role: 'user', content: 'second question', timestamp: 3 }];
        dispatch(stateSync({ messages: grown }));
        await nextFrame();
        await nextFrame();

        expect(document.querySelector('.message-user')).not.toBe(before);
        expect(document.querySelectorAll('.message-user').length).toBe(2);
    });

    it('rebuilds when a scalar tree input changes without a new messages array', async () => {
        const before = document.querySelector('.message-user');
        // rollbackPoint flips (checkpoint restore): the dimming depends on it.
        dispatch(stateSync({ rollbackPoint: 1 }));
        await nextFrame();
        await nextFrame();

        expect(document.querySelector('.message-user')).not.toBe(before);
    });
});
