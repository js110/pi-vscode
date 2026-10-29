// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

describe('choose a file path', () => {
    it('inserts the selected file path without reading file contents', async () => {
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
        const request = posted.find(m => m.type === 'chooseDroppedPaths');
        expect(request.kinds).toEqual(['unknown']);
        dispatch({ type: 'dropResolved', requestId: request.requestId, results: [{ status: 'path', path: '/home/paper.pdf' }, { status: 'path', path: '/home/image.png' }] });
        const input = document.getElementById('input') as HTMLTextAreaElement;
        expect(input.value).toContain('/home/paper.pdf');
        expect(input.value).toContain('/home/image.png');
        expect(document.querySelector('.image-chip')).toBeNull();
        expect(document.querySelector('.attach-chip')).toBeNull();
        document.getElementById('btn-send')!.click();
        const prompt = posted.find(m => m.type === 'prompt');
        expect(prompt.text).toContain('/home/paper.pdf');
        expect(prompt.images).toBeUndefined();
        expect(prompt.attachContents).toBeUndefined();
    });

    it('preserves clipboard screenshots and normal text paste', async () => {
        const input = document.getElementById('input') as HTMLTextAreaElement;
        const screenshot = new File(['png'], 'screenshot.png', { type: 'image/png' });
        const paste = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => screenshot }] } });
        input.dispatchEvent(paste);
        expect(paste.defaultPrevented).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(document.querySelector('.image-chip')).not.toBeNull();
        const mixed = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(mixed, 'clipboardData', { value: { items: [{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'image/png' }] } });
        input.dispatchEvent(mixed);
        expect(mixed.defaultPrevented).toBe(false);
    });
});
