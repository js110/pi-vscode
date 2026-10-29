// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

const posted: any[] = [];
const snapshot = (tabId: string, extra: Record<string, unknown> = {}) => ({
    activeTabId: tabId, sessionId: tabId, tabs: [{ id: tabId, name: tabId, isActive: true, isStreaming: false, hasNotification: false }],
    messages: [], isStreaming: false, tools: [], supportsImages: true, ...extra,
});
const dispatch = (data: ServerMessage) => window.dispatchEvent(new MessageEvent('message', { data }));
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    (window as any).acquireVsCodeApi = () => ({
        postMessage: (message: any) => {
            posted.push(message);
            if (message.type === 'getState') setTimeout(() => dispatch({ type: 'stateSync', state: snapshot('t1') }), 0);
            if (message.type === 'getSkills') setTimeout(() => dispatch({ type: 'skills', skills: [] }), 0);
        }, getState: () => undefined, setState: () => undefined,
    });
    await import('../../../webview/main');
    await wait(100);
});

describe('webview async state', () => {
    it('restores pending approvals on tab changes and removes resolved ones', () => {
        const approval = { toolCallId: 'call1', toolName: 'write', args: { path: 'a' } };
        dispatch({ type: 'stateSync', state: snapshot('t2', { pendingApprovals: [approval] }) });
        expect(document.getElementById('approval-call1')).not.toBeNull();
        dispatch({ type: 'stateSync', state: snapshot('t2', { pendingApprovals: [] }) });
        expect(document.getElementById('approval-call1')).toBeNull();
    });

    it('ignores older search results and background session refreshes', async () => {
        dispatch({ type: 'stateSync', state: snapshot('t1') });
        document.getElementById('btn-sessions')!.click();
        dispatch({ type: 'sessions', sessions: [{ id: 'initial', name: 'initial', path: '/initial' }] });
        let input = document.getElementById('session-search-input') as HTMLInputElement;
        input.value = 'first'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(300);
        const first = posted.filter(m => m.type === 'searchSessions').at(-1);
        input = document.getElementById('session-search-input') as HTMLInputElement;
        input.value = 'second'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(300);
        const second = posted.filter(m => m.type === 'searchSessions').at(-1);
        dispatch({ type: 'sessionSearchResults', tabId: 't1', requestId: second.requestId, sessions: [{ id: 'second', name: 'second result', path: '/second' }] });
        dispatch({ type: 'sessionSearchResults', tabId: 't1', requestId: first.requestId, sessions: [{ id: 'old', name: 'old result', path: '/old', snippet: 'first' }] });
        dispatch({ type: 'sessions', sessions: [{ id: 'background', name: 'background', path: '/background' }] });
        expect(document.getElementById('session-panel')?.textContent).toContain('second result');
        expect(document.getElementById('session-panel')?.textContent).not.toContain('old result');
    });

    it('clears the previous tab cache warming status', () => {
        dispatch({ type: 'stateSync', state: snapshot('t1', { cacheWarmingStatus: { state: 'refreshing' } }) });
        expect(document.querySelector('.warm-chip')).not.toBeNull();
        dispatch({ type: 'stateSync', state: snapshot('t2') });
        expect(document.querySelector('.warm-chip')).toBeNull();
    });
});
