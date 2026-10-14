// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import type { ServerMessage, SerializedAgentState } from '../../../shared/protocol';

/**
 * Regression (user report): with a two-line draft, pressing Up while editing
 * line 2 must move the caret, not swap the input for the previous history
 * entry. History navigation only binds at the field's edge lines.
 */
it('arrow keys move the caret inside multi-line drafts and navigate history only on edge lines', async () => {
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
            if (message.type === 'getState') dispatch({ type: 'stateSync', state: base });
        },
        getState: () => undefined, setState: () => {},
    });
    await import('../../../webview/main');
    await vi.waitFor(() => expect(document.getElementById('btn-sessions')).not.toBeNull());

    // Seed the input history with one sent message.
    const input = document.querySelector<HTMLTextAreaElement>('#input')!;
    input.value = 'history entry';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'prompt' && m.text === 'history entry')).toBe(true));
    // The prompt clears the field; wait for the UI to settle.
    await vi.waitFor(() => expect(input.value).toBe(''));

    // Two-line draft, caret at start of line 2.
    input.value = 'line one\nline two';
    input.setSelectionRange(9, 9);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(input.value).toBe('line one\nline two'); // NOT replaced by history

    // Caret on the FIRST line: Up navigates history as before.
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(input.value).toBe('history entry');

    // Restore the draft, caret on the LAST line of a single-line history
    // entry: Down navigates back out and restores the pre-navigation draft.
    input.value = 'history entry';
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(input.value).toBe('line one\nline two');
});
