// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

describe('choose a file path', () => {
    it('opens the Copilot-style attachment picker and routes results into chips', async () => {
        document.body.innerHTML = '<div id="app"></div>';
        const posted: any[] = [];
        const dispatch = (message: ServerMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
        (window as any).acquireVsCodeApi = () => ({
            getState: () => undefined, setState: () => undefined,
            postMessage: (message: any) => {
                posted.push(message);
                if (message.type === 'getState') setTimeout(() => dispatch({ type: 'stateSync', state: { activeTabId: 't1', sessionId: 's1', messages: [], tools: [], isStreaming: false, supportsImages: true } }), 0);
            },
        });
        await import('../../../webview/main');
        await new Promise(resolve => setTimeout(resolve, 60));
        document.getElementById('btn-attach')!.click();
        // Copilot "Add Context": the paperclip asks the host for the fuzzy
        // workspace picker instead of the OS dialog.
        const request = posted.find(m => m.type === 'pickAttachments');
        expect(request).toMatchObject({ type: 'pickAttachments' });
        dispatch({ type: 'dropResolved', requestId: request.requestId, results: [{ status: 'path', path: '/home/paper.pdf' }, { status: 'path', path: '/workspace/docs', directory: true }] });
        // Files become attachment chips; directories stay path references.
        const chips = [...document.querySelectorAll('.attach-chip-name')].map(el => el.textContent);
        expect(chips).toEqual(['paper.pdf']);
        const input = document.getElementById('input') as HTMLTextAreaElement;
        expect(input.value).toContain('/workspace/docs');
        document.getElementById('btn-send')!.click();
        const prompt = posted.find(m => m.type === 'prompt');
        expect(prompt.attachPaths).toEqual(['/home/paper.pdf']);
        expect(prompt.images).toBeUndefined();
    });

    it('preserves clipboard screenshots and normal text paste', async () => {
        const input = document.getElementById('input') as HTMLTextAreaElement;
        const screenshot = new File(['png'], 'screenshot.png', { type: 'image/png' });
        const paste = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => screenshot }] } });
        input.dispatchEvent(paste);
        expect(paste.defaultPrevented).toBe(true);
        // FileReader-based normalization is async: poll instead of a fixed
        // sleep so a loaded test runner can't flake the chip assertion.
        await vi.waitFor(() => {
            expect(document.querySelector('.image-chip')).not.toBeNull();
        }, { timeout: 2000, interval: 25 });
        const mixed = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(mixed, 'clipboardData', { value: { items: [{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'image/png' }] } });
        input.dispatchEvent(mixed);
        expect(mixed.defaultPrevented).toBe(false);
    });
});
