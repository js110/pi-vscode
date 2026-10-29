// @vitest-environment happy-dom
//
// Exercises the REAL chat webview bootstrap (src/webview/main.ts) inside
// happy-dom with a mock `acquireVsCodeApi`. Guards the copy defense layers:
// VS Code intercepts Cmd/Ctrl+C and the context menu's Copy while a webview
// view has focus, then restores focus to the composer input — so the copy
// command lands on the input's empty selection and the user's transcript
// selection is never copied. The webview defends itself:
//   1. 'copy' event hook forces the transcript text into any copy command,
//   2. capture-phase Cmd/Ctrl+C performs the copy itself (host bridge
//      fallback when the iframe's Clipboard API is rejected),
//   3. right-click with a live selection opens an in-page menu whose Copy
//      goes through the host bridge,
// and a selection inside the composer still wins over the transcript mark.
//
// main.ts installs a `window` message listener on import and ESM caches the
// module, so the harness boots once in beforeAll.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

const posted: any[] = [];

function dispatch(m: ServerMessage): void {
    window.dispatchEvent(new MessageEvent('message', { data: m }));
}

const MESSAGES = [
    { role: 'user', content: 'hello there', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'the marked passage lives here' }], timestamp: 2 },
];

function stateSync(withMessages: boolean): ServerMessage {
    const base: Record<string, unknown> = {
        sessionId: 's1',
        sessionName: 'CopyDef',
        activeTabId: 't1',
        tabs: [{ id: 't1', name: 'CopyDef', isActive: true, isStreaming: false, hasNotification: false }],
        isStreaming: false,
        tools: [],
        model: { provider: 'anthropic', id: 'claude-smoke', name: 'Claude Smoke' },
        supportsImages: true,
    };
    if (withMessages) base.messages = MESSAGES;
    return { type: 'stateSync', state: base } as unknown as ServerMessage;
}

async function nextFrame(): Promise<void> {
    await new Promise((r) => setTimeout(r, 40));
}

/** Drag-mark part of the assistant message. */
function selectTranscriptText(start: number, end: number): void {
    const p = [...document.querySelectorAll('.message-group-assistant .message-content p')][0];
    const firstChild = p?.firstChild;
    expect(firstChild).toBeTruthy();
    const range = document.createRange();
    range.setStart(firstChild!, start);
    range.setEnd(firstChild!, end);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const api = {
        postMessage: (m: any) => {
            posted.push(m);
            if (m.type === 'getState') setTimeout(() => dispatch(stateSync(true)), 0);
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

function stubClipboard(value: { writeText?: (t: string) => Promise<void> } | undefined): void {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true });
}

describe('copy defense', () => {
    beforeEach(() => {
        posted.length = 0;
        stubClipboard(undefined);
    });

    it('re-dispatched copy commands carry the transcript selection (copy event hook)', () => {
        selectTranscriptText(4, 18);
        const data = new DataTransfer();
        const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
        document.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(data.getData('text/plain')).toBe('marked passage');
    });

    it('Cmd/Ctrl+C with a transcript selection copies it and stops the default path', async () => {
        stubClipboard({ writeText: vi.fn(async () => {}) });
        selectTranscriptText(4, 18);
        // Focus the composer the way VS Code's focus restoration does — the
        // selection must still be the copy target.
        const input = document.getElementById('input') as HTMLTextAreaElement;
        input.focus();
        input.setSelectionRange(0, 0);

        const keydown = new KeyboardEvent('keydown', {
            key: 'c', ctrlKey: true, bubbles: true, cancelable: true,
        });
        Object.defineProperty(keydown, 'target', { value: input });
        document.dispatchEvent(keydown);

        expect(keydown.defaultPrevented).toBe(true);
        const local = (navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> }).writeText;
        expect(local).toHaveBeenCalledWith('marked passage');
        expect(keydown.defaultPrevented).toBe(true);
    });

    it('Cmd/Ctrl+C falls back to the host bridge when the iframe clipboard rejects', async () => {
        stubClipboard({
            writeText: vi.fn(async () => {
                throw new DOMException('Document is not focused.', 'NotAllowedError');
            }),
        });
        selectTranscriptText(4, 18);
        const keydown = new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(keydown);
        await nextFrame();

        const bridge = posted.find((m) => m.type === 'copyText');
        expect(bridge).toMatchObject({ type: 'copyText', text: 'marked passage' });
    });

    it('Cmd/Ctrl+C still copies after focus restoration collapsed the selection', async () => {
        // The exact VS Code sequence: mark text → selectionchange snapshots it
        // → focusing the composer collapses the document selection → the key
        // arrives with the selection gone. The snapshot must carry the copy.
        selectTranscriptText(4, 18);
        document.dispatchEvent(new Event('selectionchange'));
        // Simulate VS Code restoring focus to the composer (kills selection).
        const input = document.getElementById('input') as HTMLTextAreaElement;
        input.focus();
        window.getSelection()?.removeAllRanges();

        const keydown = new KeyboardEvent('keydown', {
            key: 'c', ctrlKey: true, bubbles: true, cancelable: true,
        });
        Object.defineProperty(keydown, 'target', { value: input });
        document.dispatchEvent(keydown);
        await nextFrame();

        expect(keydown.defaultPrevented).toBe(true);
        const bridge = posted.find((m) => m.type === 'copyText');
        expect(bridge).toMatchObject({ type: 'copyText', text: 'marked passage' });
    });

    it('a selection inside the composer wins over the transcript mark', () => {
        selectTranscriptText(4, 18);
        const input = document.getElementById('input') as HTMLTextAreaElement;
        input.value = 'draft with selected words';
        input.setSelectionRange(0, 5);
        input.focus();

        const data = new DataTransfer();
        const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
        Object.defineProperty(event, 'target', { value: input });
        document.dispatchEvent(event);

        // Not our hook's business: the composer selection handles itself.
        expect(event.defaultPrevented).toBe(false);
    });

    it('does not copy an old transcript selection after a new click', () => {
        selectTranscriptText(4, 18);
        document.dispatchEvent(new Event('selectionchange'));
        const input = document.getElementById('input') as HTMLTextAreaElement;
        input.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
        window.getSelection()?.removeAllRanges();
        input.setSelectionRange(0, 0);
        const keydown = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
        input.dispatchEvent(keydown);
        expect(keydown.defaultPrevented).toBe(false);
        expect(posted.find((m) => m.type === 'copyText')).toBeUndefined();
    });

    it('copies a selection longer than the quote limit after focus changes', () => {
        const content = document.querySelector('.message-group-assistant .message-content p')!;
        const original = content.textContent;
        const longText = 'a'.repeat(40001);
        content.textContent = longText;
        const range = document.createRange();
        range.selectNodeContents(content);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        window.getSelection()?.removeAllRanges();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
        expect(posted.find((m) => m.type === 'copyText')).toMatchObject({ type: 'copyText', text: longText });
        content.textContent = original;
    });

    it('right-click with a live selection opens the in-page copy menu', async () => {
        selectTranscriptText(4, 18);
        const messages = document.getElementById('messages') as HTMLElement;
        const ctx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
        messages.dispatchEvent(ctx);
        expect(ctx.defaultPrevented).toBe(true);

        const menu = document.querySelector('.ctx-menu') as HTMLElement | null;
        expect(menu).toBeTruthy();
        const item = menu!.querySelector('.ctx-menu-item') as HTMLButtonElement;
        expect(item.textContent).toContain('Copy selection');

        stubClipboard({ writeText: vi.fn(async () => {}) });
        item.click();
        await nextFrame();
        const local = (navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> }).writeText;
        expect(local).toHaveBeenCalledWith('marked passage');
        expect(document.querySelector('.ctx-menu')).toBeNull();
    });

    it('right-click without a transcript selection keeps the native menu', () => {
        window.getSelection()?.removeAllRanges();
        const messages = document.getElementById('messages') as HTMLElement;
        const ctx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
        messages.dispatchEvent(ctx);
        expect(ctx.defaultPrevented).toBe(false);
        expect(document.querySelector('.ctx-menu')).toBeNull();
    });
});
