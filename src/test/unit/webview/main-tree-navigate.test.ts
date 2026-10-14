// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import type { ServerMessage, SerializedAgentState } from '../../../shared/protocol';

/**
 * Realistic session-tree shape: a fork with two branches, current flags along
 * the active leaf path. Clicking a NON-current branch entry must dispatch
 * navigateSessionTree (user report: tree clicks do nothing while list clicks
 * work).
 */
it('dispatches navigateSessionTree for a non-current branch in a forked tree', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const sent: any[] = [];
    const dispatch = (message: ServerMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
    const base: SerializedAgentState = {
        isStreaming: false, messages: [], tools: [], sessionId: 's1', activeTabId: 't1',
        tabs: [{ id: 't1', name: 'One', isActive: true, isStreaming: false, hasNotification: false }],
    };
    (window as any).acquireVsCodeApi = () => ({
        postMessage: (message: any) => {
            sent.push(message);
            if (message.type === "getState") dispatch({ type: "stateSync", state: base });
        },
        getState: () => undefined, setState: () => {},
    });
    await import('../../../webview/main');
    await vi.waitFor(() => expect(document.getElementById('btn-sessions')).not.toBeNull());

    // Open the tree with a forked shape: current path e0→e1→e2, sibling e3.
    dispatch({ type: 'sessionTree', tabId: 't1', entries: [
        { id: 'e0', parentId: null, depth: 0, kind: 'user', text: 'first question', current: true },
        { id: 'e1', parentId: 'e0', depth: 1, kind: 'assistant', text: 'answer', current: true },
        { id: 'e2', parentId: 'e1', depth: 2, kind: 'user', text: 'current leaf', current: true },
        { id: 'e3', parentId: 'e1', depth: 2, kind: 'user', text: 'other branch', current: false },
    ] });
    expect(document.getElementById('tree-panel')).not.toBeNull();

    // The current leaf's button is disabled; the other branch must be clickable.
    const currentBtn = document.querySelector<HTMLButtonElement>('[data-entry-id="e2"] .tree-navigate')!;
    expect(currentBtn.disabled).toBe(true);
    const otherBtn = document.querySelector<HTMLButtonElement>('[data-entry-id="e3"] .tree-navigate')!;
    expect(otherBtn.disabled).toBe(false);

    otherBtn.click();
    expect(sent.some((m) => m.type === 'navigateSessionTree' && m.entryId === 'e3')).toBe(true);
});
