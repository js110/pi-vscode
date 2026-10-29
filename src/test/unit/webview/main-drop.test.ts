// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

const posted: any[] = [];
const dispatch = (data: ServerMessage) => window.dispatchEvent(new MessageEvent('message', { data }));
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    (window as any).acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => undefined, postMessage: (message: any) => {
        posted.push(message);
        if (message.type === 'getState') setTimeout(() => dispatch({ type: 'stateSync', state: { activeTabId: 't1', sessionId: 's1', messages: [], tools: [], isStreaming: false, supportsImages: true } }), 0);
    } });
    await import('../../../webview/main');
    await pause(); await pause();
});
function drop(target: Element, dataTransfer: unknown) {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    target.dispatchEvent(event);
    return event;
}

describe('file drops in the chat panel', () => {
    it('asks for the directory path without enumerating its contents', async () => {
        const dir = { name: 'docs', isFile: false, isDirectory: true, createReader: () => { throw new Error('must not enumerate'); } };
        const event = drop(document.getElementById('messages')!, { types: ['Files'], getData: () => '', files: [], items: [{ kind: 'file', webkitGetAsEntry: () => dir }] });
        expect(event.defaultPrevented).toBe(true);
        const request = posted.find(m => m.type === 'chooseDroppedPaths');
        expect(request.kinds).toEqual(['directory']);
        dispatch({ type: 'dropResolved', requestId: request.requestId, results: [{ status: 'path', path: '/Users/me/My Docs' }] });
        expect((document.getElementById('input') as HTMLTextAreaElement).value).toContain('"/Users/me/My Docs"');
        expect(document.querySelector('.attach-chip-name')).toBeNull();
        await pause();
    });
    it('sends URI drops once even if files are also exposed', () => {
        posted.length = 0;
        drop(document.getElementById('messages')!, { types: ['Files', 'text/uri-list'], getData: (type: string) => type === 'text/uri-list' ? 'file:///workspace/docs' : '', files: [new File(['x'], 'x.txt')], items: [] });
        expect(posted.filter(m => m.type === 'dropFiles')).toHaveLength(1);
        const request = posted.find(m => m.type === 'dropFiles');
        expect(request.uris).toEqual(['file:///workspace/docs']);
        dispatch({ type: 'dropResolved', requestId: request.requestId, results: [{ status: 'path', path: '/workspace/docs' }] });
        expect((document.getElementById('input') as HTMLTextAreaElement).value).toContain('/workspace/docs');
        expect(document.querySelector('.attach-chip-name')).toBeNull();
    });
    it('accepts Explorer file drops using VS Code resource payloads', () => {
        posted.length = 0;
        const payload = JSON.stringify(['file:///workspace/a.txt', 'file:///workspace/b.txt']);
        const event = drop(document.getElementById('messages')!, { types: ['resourceurls'], getData: (type: string) => type.toLowerCase() === 'resourceurls' ? payload : '', items: [], files: [] });
        expect(event.defaultPrevented).toBe(true);
        expect(posted.find(m => m.type === 'dropFiles').uris).toEqual(['file:///workspace/a.txt', 'file:///workspace/b.txt']);
    });
    it('accepts Explorer CodeFiles paths and preserves special characters', () => {
        posted.length = 0;
        const event = drop(document.getElementById('messages')!, { types: ['codefiles'], getData: (type: string) => type.toLowerCase() === 'codefiles' ? JSON.stringify(['/workspace/a #1.txt']) : '', items: [], files: [] });
        expect(event.defaultPrevented).toBe(true);
        expect(posted.find(m => m.type === 'dropFiles').uris).toEqual(['file:///workspace/a%20%231.txt']);
    });
    it('requests a file path when the operating system does not expose one', () => {
        posted.length = 0;
        const entry = { name: 'paper.pdf', isFile: true, isDirectory: false, file: () => { throw new Error('must not read'); } };
        drop(document.getElementById('messages')!, { types: ['Files'], getData: () => '', files: [], items: [{ kind: 'file', webkitGetAsEntry: () => entry }] });
        const request = posted.find(m => m.type === 'chooseDroppedPaths');
        expect(request.kinds).toEqual(['file']);
        dispatch({ type: 'dropResolved', requestId: request.requestId, results: [{ status: 'path', path: '/Users/me/paper.pdf' }] });
        expect((document.getElementById('input') as HTMLTextAreaElement).value).toContain('/Users/me/paper.pdf');
        expect(document.querySelector('.attach-chip-name')).toBeNull();
    });
    it('asks what kind of item was dropped when the browser cannot identify it', () => {
        posted.length = 0;
        drop(document.getElementById('messages')!, { types: ['Files'], getData: () => '', files: [], items: [{ kind: 'file', webkitGetAsEntry: () => null }] });
        expect(posted.find(m => m.type === 'chooseDroppedPaths').kinds).toEqual(['unknown']);
    });
    it('accepts provisional drag events with no exposed types and handles the file on drop', () => {
        posted.length = 0;
        const messages = document.getElementById('messages')!;
        const over = new Event('dragover', { bubbles: true, cancelable: true });
        Object.defineProperty(over, 'dataTransfer', { value: { types: [] } });
        messages.dispatchEvent(over);
        expect(over.defaultPrevented).toBe(true);
        const entry = { name: 'paper.pdf', isFile: true, isDirectory: false };
        const event = drop(messages, { types: [], getData: () => '', files: [], items: [{ kind: 'file', webkitGetAsEntry: () => entry }] });
        expect(event.defaultPrevented).toBe(true);
        expect(posted.find(m => m.type === 'chooseDroppedPaths').kinds).toEqual(['file']);
    });
    it('does not intercept an ordinary web link drop', () => {
        const event = drop(document.getElementById('messages')!, { types: ['text/uri-list'], getData: () => 'https://example.com', items: [], files: [] });
        expect(event.defaultPrevented).toBe(false);
    });
    it('quotes a leading path so it is not interpreted as a slash command', () => {
        posted.length = 0;
        const input = document.getElementById('input') as HTMLTextAreaElement;
        input.value = '';
        drop(document.getElementById('messages')!, { types: ['Files', 'text/uri-list'], getData: () => 'file:///new', items: [], files: [] });
        const request = posted.find(m => m.type === 'dropFiles');
        dispatch({ type: 'dropResolved', requestId: request.requestId, results: [{ status: 'path', path: '/new' }] });
        document.getElementById('btn-send')!.click();
        expect(posted.find(m => m.type === 'prompt').text).toBe('"/new"');
    });
});
