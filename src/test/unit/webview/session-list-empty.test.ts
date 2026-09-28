// @vitest-environment happy-dom
//
// Exercises the REAL chat webview bootstrap (src/webview/main.ts) inside
// happy-dom with a mock `acquireVsCodeApi`. The history session panel only
// opens on an explicit user action: a background 'sessions' push (e.g. the
// auto-rename after a turn) must never mount it. When the user DOES open it
// and there are NO sessions, the panel must still be closable: the
// empty-state render includes the same close affordance as the populated
// state. Regression test for "弹 session 列表" + "弹出历史 session 列表后关不掉".

import { describe, it, expect, vi } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

// main.ts is a module-level singleton (webview state + window listeners live
// in module scope), so every test re-executes it via vi.resetModules().

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
            if (m.type === 'getSessions') {
                setTimeout(() => dispatch({ type: 'sessions', sessions: [], currentSessionId: 's1' }), 0);
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
    it('rare background sessions push must not auto-mount the panel', async () => {
        installHarness();

        vi.resetModules();
        await import('../../../webview/main');
        await nextFrame();
        await nextFrame();

        // No session panel before the user asks for one.
        expect(document.getElementById('session-panel'), 'panel is absent before open').toBeNull();

        // A background push (auto-rename after a turn, etc.) must NOT mount it.
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'sessions', sessions: [], currentSessionId: 's1' } }));
        await nextFrame();
        expect(document.getElementById('session-panel'), 'background sessions push must not open the panel').toBeNull();
    });

    it('empty session list panel is openable and closable', async () => {
        installHarness();

        vi.resetModules();
        await import('../../../webview/main');
        await nextFrame();
        await nextFrame();

        // Open via the header button (the only path that mounts the panel).
        const btn = document.getElementById('btn-sessions');
        expect(btn, 'header sessions button should exist').not.toBeNull();
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await nextFrame();
        await nextFrame();

        const panel = document.getElementById('session-panel');
        expect(panel, 'session panel should appear after opening').not.toBeNull();

        const closeBtn = document.getElementById('btn-close-sessions');
        expect(closeBtn, 'empty state must still render a close button').not.toBeNull();
        closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(document.getElementById('session-panel'), 'panel is removed when close is clicked').toBeNull();
    });
});