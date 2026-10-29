// @vitest-environment happy-dom
//
// Exercises the REAL chat webview bootstrap (src/webview/main.ts) inside
// happy-dom with a mock `acquireVsCodeApi`, driving host messages the way the
// extension host does. Guards the clipboard paths:
//   - navigator.clipboard absent (the VS Code cross-origin webview iframe
//     case, microsoft/vscode#182642) → copy falls back to the copyText host
//     bridge and the clipboardResult ack drives the button feedback,
//   - navigator.clipboard working → feedback is local, no host round-trip,
//   - navigator.clipboard rejecting (Document is not focused) → same bridge,
//   - the per-reply hover copy action sends the raw reply markdown.
//
// main.ts installs a `window` message listener on import and ESM caches the
// module, so the harness boots once in beforeAll and every scenario clicks
// the shared tree. Label assertions run immediately after their own click,
// so the 1.5s restore timer never races a later assertion.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

const posted: any[] = [];

function dispatch(m: ServerMessage): void {
    window.dispatchEvent(new MessageEvent('message', { data: m }));
}

const SNAPSHOT = {
    type: 'stateSync',
    state: {
        sessionId: 's1',
        sessionName: 'Copy',
        activeTabId: 't1',
        tabs: [{ id: 't1', name: 'Copy', isActive: true, isStreaming: false, hasNotification: false }],
        messages: [
            { role: 'user', content: 'show me code', timestamp: 1 },
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'Here you go:\n\n```js\nconst x = 1;\n```\n\nDone.' }],
                timestamp: 2,
            },
        ],
        isStreaming: false,
        tools: [] as string[],
        model: { provider: 'anthropic', id: 'claude-smoke', name: 'Claude Smoke' },
        supportsImages: true,
    },
    images: {},
} as unknown as ServerMessage;

beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';

    const api = {
        postMessage: (m: any) => {
            posted.push(m);
            if (m.type === 'getState') {
                setTimeout(() => dispatch(SNAPSHOT), 0);
            }
        },
        getState: () => undefined,
        setState: () => undefined,
    };
    (window as unknown as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => api;

    await import('../../../webview/main');
    // Flush the getState handshake, the markdown chunk load, and the render.
    for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 40));
    }
});

/** happy-dom's default navigator has no clipboard; tests control it per case. */
function stubClipboard(value: { writeText?: (t: string) => Promise<void> } | undefined): void {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true });
}

async function flush(): Promise<void> {
    for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 20));
    }
}

describe('webview copy paths', () => {
    beforeEach(() => {
        posted.length = 0;
        stubClipboard(undefined);
    });

    it('renders the conversation with both copy actions', () => {
        expect(document.querySelectorAll('.copy-btn').length).toBe(1);
        expect(document.querySelectorAll('.msg-copy-btn').length).toBe(1);
    });

    it('falls back to the host bridge when navigator.clipboard is absent', async () => {
        const btn = document.querySelector('.copy-btn') as HTMLButtonElement;
        btn.click();

        // No local clipboard → the write must go through the host bridge, and
        // until the ack arrives the button must not claim success.
        const request = posted.find((m) => m.type === 'copyText');
        expect(request).toMatchObject({ type: 'copyText', text: 'const x = 1;' });
        expect(btn.textContent).toBe('Copy');

        dispatch({ type: 'clipboardResult', requestId: request.requestId, ok: true });
        expect(btn.textContent).toBe('Copied!');
    });

    it('keeps feedback local when navigator.clipboard works', async () => {
        const writeText = vi.fn(async () => {});
        stubClipboard({ writeText });
        const btn = document.querySelector('.copy-btn') as HTMLButtonElement;
        btn.click();
        await flush();

        expect(writeText).toHaveBeenCalledWith('const x = 1;');
        expect(posted.some((m) => m.type === 'copyText')).toBe(false);
        expect(btn.textContent).toBe('Copied!');
    });

    it('falls back to the host bridge when navigator.clipboard rejects', async () => {
        stubClipboard({
            writeText: vi.fn(async () => {
                throw new DOMException('Document is not focused.', 'NotAllowedError');
            }),
        });
        const btn = document.querySelector('.copy-btn') as HTMLButtonElement;
        btn.click();
        await flush();

        expect(posted.some((m) => m.type === 'copyText' && m.text === 'const x = 1;')).toBe(true);
    });

    it('copies the raw reply markdown from the turn-head action', async () => {
        const btn = document.querySelector('.msg-copy-btn') as HTMLButtonElement;
        btn.click();

        const bridge = posted.find((m) => m.type === 'copyText');
        expect(bridge.text).toBe('Here you go:\n\n```js\nconst x = 1;\n```\n\nDone.');

        dispatch({ type: 'clipboardResult', requestId: bridge.requestId, ok: true });
        expect(btn.querySelector('.codicon-check')).toBeTruthy();
    });

    it('routes out-of-order acknowledgements to the matching copy button', () => {
        const code = document.querySelector('.copy-btn') as HTMLButtonElement;
        const reply = document.querySelector('.msg-copy-btn') as HTMLButtonElement;
        code.textContent = 'Copy';
        code.click();
        reply.click();
        const requests = posted.filter((m) => m.type === 'copyText');
        expect(requests).toHaveLength(2);
        dispatch({ type: 'clipboardResult', requestId: requests[1].requestId, ok: true });
        expect(reply.querySelector('.codicon-check')).toBeTruthy();
        expect(code.textContent).toBe('Copy');
        dispatch({ type: 'clipboardResult', requestId: requests[0].requestId, ok: true });
        expect(code.textContent).toBe('Copied!');
    });
});
