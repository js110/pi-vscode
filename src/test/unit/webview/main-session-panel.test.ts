// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import type { ServerMessage, SerializedAgentState } from '../../../shared/protocol';

/**
 * Regression (user report): clicking a session in the session list must land
 * on that conversation — the full-height session panel must close when the
 * stateSync with the new sessionId arrives, not stay open.
 */
it('closes the session panel when a list click lands on a new session', async () => {
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
            if (message.type === 'getState') setTimeout(() => dispatch({ type: 'stateSync', state: base }), 0);
        },
        getState: () => undefined, setState: () => {},
    });
    await import('../../../webview/main');
    await vi.waitFor(() => expect(document.getElementById('btn-sessions')).not.toBeNull());

    // Open the session list panel.
    document.getElementById('btn-sessions')!.click();
    expect(document.getElementById('session-panel')).not.toBeNull();

    // The list is empty until 'sessions' arrives; push one entry and re-open.
    dispatch({ type: 'sessions', currentSessionId: 's1', sessions: [
        { id: 'other', name: 'Other session', path: '/two.jsonl', lastModified: 2 },
    ] } as any);
    expect(document.querySelector('.session-item[data-path="/two.jsonl"]')).not.toBeNull();

    // Click the entry: the webview must request the load.
    document.querySelector<HTMLElement>('.session-item[data-path="/two.jsonl"]')!.click();
    expect(sent).toContainEqual({ type: 'loadSession', sessionPath: '/two.jsonl' });

    // Host acknowledges with a stateSync carrying the NEW sessionId: the
    // panel must be gone so the user lands on the conversation.
    dispatch({ type: 'stateSync', state: { ...base, sessionId: 'other' } });
    expect(document.getElementById('session-panel')).toBeNull();
});
