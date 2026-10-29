// @vitest-environment happy-dom
//
// Exercises the REAL chat webview bootstrap (src/webview/main.ts) inside
// happy-dom with a mock `acquireVsCodeApi`. Guards the conversation-quote
// feature end to end on the webview side:
//   - marking text inside a message shows the quote chip,
//   - selections in the composer never trigger it,
//   - a normal send rides quotedText (one-shot, chip clears),
//   - a slash command neither carries the quote nor burns it,
//   - dismissing clears the chip,
//   - sending while scrolled up keeps the viewport in place (no yank to
//     bottom), and a tab switch drops the quote.
//
// main.ts installs a `window` message listener on import and ESM caches the
// module, so the harness boots once in beforeAll.

import { describe, it, expect, beforeAll } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

const posted: any[] = [];

function dispatch(m: ServerMessage): void {
    window.dispatchEvent(new MessageEvent('message', { data: m }));
}

const MESSAGES = [
    { role: 'user', content: 'hello there', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'the marked passage lives here' }], timestamp: 2 },
];

function stateSync(overrides: Record<string, unknown> = {}, withMessages = false): ServerMessage {
    const base: Record<string, unknown> = {
        sessionId: 's1',
        sessionName: 'Quote',
        activeTabId: 't1',
        tabs: [
            { id: 't1', name: 'Quote', isActive: true, isStreaming: false, hasNotification: false },
            { id: 't2', name: 'Other', isActive: false, isStreaming: false, hasNotification: false },
        ],
        isStreaming: false,
        tools: [],
        model: { provider: 'anthropic', id: 'claude-smoke', name: 'Claude Smoke' },
        supportsImages: true,
    };
    if (withMessages) base.messages = MESSAGES;
    return { type: 'stateSync', state: { ...base, ...overrides } } as unknown as ServerMessage;
}

async function nextFrame(): Promise<void> {
    await new Promise((r) => setTimeout(r, 40));
}

/** Simulate the user dragging over text inside an assistant message. */
async function selectInAssistantText(start: number, end: number): Promise<void> {
    const ok = (() => {
        const p = [...document.querySelectorAll('.message-group-assistant .message-content p')][0];
        const firstChild = p?.firstChild;
        if (!firstChild) return false;
        const range = document.createRange();
        range.setStart(firstChild, start);
        range.setEnd(firstChild, end);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return true;
    })();
    expect(ok).toBe(true);
    // The capture is debounced on the webview side.
    await new Promise((r) => setTimeout(r, 350));
}

function setInput(value: string): void {
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = value;
}

beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const api = {
        postMessage: (m: any) => {
            posted.push(m);
            if (m.type === 'getState') setTimeout(() => dispatch(stateSync({}, true)), 0);
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

describe('conversation quote', () => {
    it('shows the chip when text inside a message is marked', async () => {
        expect(document.getElementById('quote-chip')).toBeTruthy();
        await selectInAssistantText(4, 18);
        expect(document.activeElement?.id).toBe('input');
        const chip = document.getElementById('quote-chip') as HTMLElement;
        expect(chip.style.display).not.toBe('none');
        expect(chip.textContent).toContain('marked passage');
    });

    it('never triggers from a composer selection', async () => {
        // Select inside the textarea the way typing selections do.
        const input = document.getElementById('input') as HTMLTextAreaElement;
        setInput('draft text');
        input.setSelectionRange(0, 5);
        document.dispatchEvent(new Event('selectionchange'));
        await new Promise((r) => setTimeout(r, 350));
        // The previous message mark is still the quote (composer selection
        // neither replaces nor clears it).
        const chip = document.getElementById('quote-chip') as HTMLElement;
        expect(chip.textContent).toContain('marked passage');
    });

    it('rides the next prompt one-shot and clears the chip', async () => {
        setInput('what does this mean');
        (document.getElementById('input') as HTMLTextAreaElement)
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await nextFrame();

        const prompt = posted.find((m) => m.type === 'prompt');
        expect(prompt).toBeTruthy();
        expect(prompt.text).toBe('what does this mean');
        expect(prompt.quotedText).toBe('marked passage');

        const chip = document.getElementById('quote-chip') as HTMLElement;
        expect(chip.style.display).toBe('none');
    });

    it('keeps the quote when the send is a slash command', async () => {
        await selectInAssistantText(0, 4);
        setInput('/model');
        (document.getElementById('input') as HTMLTextAreaElement)
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await nextFrame();

        const prompt = posted.filter((m) => m.type === 'prompt').at(-1);
        expect(prompt.quotedText).toBeUndefined();

        const chip = document.getElementById('quote-chip') as HTMLElement;
        expect(chip.style.display).not.toBe('none');
    });

    it('dismiss clears the chip', async () => {
        (document.querySelector('#quote-chip .selection-chip-close') as HTMLElement).click();
        const chip = document.getElementById('quote-chip') as HTMLElement;
        expect(chip.style.display).toBe('none');
        document.getSelection()?.removeAllRanges();
        document.dispatchEvent(new Event('selectionchange'));
        await new Promise(resolve => setTimeout(resolve, 350));
        expect(chip.style.display).toBe('none');
    });

    it('sending while scrolled up does not yank the viewport to the bottom', async () => {
        const messages = document.getElementById('messages') as HTMLElement;
        // Pretend a long transcript: the container is scrolled to the top and
        // the user has claimed scroll control by wheeling up.
        Object.defineProperty(messages, 'scrollHeight', { value: 5000, configurable: true });
        Object.defineProperty(messages, 'clientHeight', { value: 400, configurable: true });
        messages.scrollTop = 0;
        messages.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));

        await selectInAssistantText(4, 18);
        setInput('ask about the marked text');
        (document.getElementById('input') as HTMLTextAreaElement)
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        // The turn starts streaming: frames arrive, content grows, but the
        // viewport must stay at the user's position.
        dispatch(stateSync({ isStreaming: true, streamingText: 'streaming answer...' }, true));
        await nextFrame();
        await nextFrame();

        expect(messages.scrollTop).toBe(0);
    });

    it('drops the quote when switching tabs', async () => {
        await selectInAssistantText(4, 18);
        expect((document.getElementById('quote-chip') as HTMLElement).style.display).not.toBe('none');
        dispatch(stateSync({ activeTabId: 't2' }));
        await nextFrame();
        expect((document.getElementById('quote-chip') as HTMLElement).style.display).toBe('none');
    });
});
