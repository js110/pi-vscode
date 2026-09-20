// @vitest-environment happy-dom
//
// Exercises the REAL chat webview bootstrap (src/webview/main.ts) inside
// happy-dom with a mock `acquireVsCodeApi`. When the user opens the history
// session panel and there are NO sessions, the panel must still be closable:
// the empty-state render must include the same close affordance as the
// populated state. Regression test for "弹出历史 session 列表后关不掉".

import { describe, it, expect } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

interface ApiMock {
    postMessage: (m: any) => void;
    getState: () => unknown;
    setState: (s: unknown) => void;
}

function installHarness(): ApiMock {
    document.body.innerHTML = '<div id="app"></div>';

    const snapshot = {
        sessionId: 's1',
        sessionName: 'Smoke',
        activeTabId: 't1',
        tabs: [{ id: 't1', name: 'Smoke', isActive: true, isStreaming: false, hasNotification: false }],
        messages: [] as any[],
        isStreaming: false,
        tools: [] as string[],
        model: { provider: 'anthropic', id: 'claude-smoke', name: 'Claude Smoke' },
        supportsImages: true,
    };

    const dispatch = (data: ServerMessage): void => {
        window.dispatchEvent(new MessageEvent('message', { data }));
    };

    const api: ApiMock = {
        postMessage: (m: any) => {
            if (m.type === 'getState') {
                setTimeout(() => dispatch({ type: 'stateSync', state: snapshot, images: {} }), 0);
            }
            if (m.type === 'getSkills') {
                setTimeout(() => dispatch({ type: 'skills', skills: [] }), 0);
            }
        },
        getState: () => undefined,
        setState: () => undefined,
    };

    (window as unknown as { acquireVsCodeApi?: () => ApiMock }).acquireVsCodeApi = () => api;
    return api;
}

async function nextFrame(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
}

describe('history session panel (real main.ts), ' + __filename.split(/[\\/]/).pop()!, () => {
    it('empty session list panel is closable', async () => {
        installHarness();

        await import('../../../webview/main');
        await nextFrame();
        await nextFrame();

        // Empty list: no previous sessions.
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'sessions', sessions: [], currentSessionId: 's1' } }));
        await nextFrame();

        const panel = document.getElementById('session-panel');
        expect(panel, 'session panel should appear').not.toBeNull();

        const closeBtn = document.getElementById('btn-close-sessions');
        expect(closeBtn, 'empty state must still render a close button').not.toBeNull();
        closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(document.getElementById('session-panel'), 'panel is removed when close is clicked').toBeNull();
    });
});