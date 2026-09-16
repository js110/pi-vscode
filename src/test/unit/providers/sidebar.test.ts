import { describe, it, expect, vi } from 'vitest';
import { SidebarProvider } from '../../../providers/sidebar';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol';

function makeTabManager() {
    return {
        onStateChange: vi.fn(() => () => {}),
        getSnapshot: vi.fn(() => ({
            state: { messages: [{ role: 'user', content: 'hi' }], isStreaming: false, tools: [] },
            images: undefined,
        })),
        getState: vi.fn(() => ({ messages: [], isStreaming: false, tools: [] })),
        initialize: vi.fn(async () => {}),
        postConfigSnapshot: vi.fn(async () => {}),
        dispatch: vi.fn(async () => {}),
        dispose: vi.fn(),
    } as any;
}

function makeWebviewView() {
    const disposeCbs: (() => void)[] = [];
    const posted: ServerMessage[] = [];
    return {
        view: {
            webview: {
                options: {},
                html: '',
                cspSource: 'test-csp',
                asWebviewUri: vi.fn((u: unknown) => u),
                onDidReceiveMessage: vi.fn(),
                postMessage: vi.fn(async (msg: ServerMessage) => {
                    posted.push(msg);
                    return true;
                }),
            },
            onDidDispose: vi.fn((cb: () => void) => {
                disposeCbs.push(cb);
                return { dispose: () => {} };
            }),
        } as any,
        posted,
        fireDispose: () => disposeCbs.forEach((cb) => cb()),
    };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeSelectionTracker(overrides: Partial<{
    current: unknown;
    consumePrompt: (text: string) => string | null;
}> = {}) {
    return {
        current: overrides.current ?? null,
        consumePrompt: overrides.consumePrompt ?? vi.fn(() => null),
        dismiss: vi.fn(),
        reinstate: vi.fn(),
    } as any;
}

describe('SidebarProvider webview lifecycle', () => {
    it('does not tear down the TabManager when the webview is disposed', () => {
        // VS Code destroys sidebar webviews whenever the view is hidden; the
        // TabManager (and its sessions) must survive hide/show cycles.
        const tm = makeTabManager();
        const provider = new SidebarProvider({} as any, tm, makeSelectionTracker());
        const { view, fireDispose } = makeWebviewView();

        provider.resolveWebviewView(view, {} as any, {} as any);
        fireDispose();

        expect(tm.dispose).not.toHaveBeenCalled();
    });

    it('re-posts the full conversation state when the view is re-resolved', async () => {
        const tm = makeTabManager();
        const provider = new SidebarProvider({} as any, tm, makeSelectionTracker());
        const first = makeWebviewView();
        provider.resolveWebviewView(first.view, {} as any, {} as any);
        await flush();
        first.fireDispose();

        const second = makeWebviewView();
        provider.resolveWebviewView(second.view, {} as any, {} as any);
        await flush();

        expect(tm.initialize).toHaveBeenCalledTimes(2);
        const syncs = second.posted.filter((m) => m.type === 'stateSync');
        expect(syncs.length).toBeGreaterThanOrEqual(1);
        const last = syncs.at(-1) as Extract<ServerMessage, { type: 'stateSync' }>;
        expect(last.state.messages).toHaveLength(1);
    });

    it('routes webview messages to the TabManager dispatcher', async () => {
        const tm = makeTabManager();
        const provider = new SidebarProvider({} as any, tm, makeSelectionTracker());
        const { view } = makeWebviewView();
        provider.resolveWebviewView(view, {} as any, {} as any);

        const handler = view.webview.onDidReceiveMessage.mock.calls[0][0] as (m: ClientMessage) => void;
        handler({ type: 'prompt', text: 'hello' });
        await flush();

        expect(tm.dispatch).toHaveBeenCalledWith({ type: 'prompt', text: 'hello' });
    });

    it('wraps a plain prompt with the active selection', async () => {
        const tm = makeTabManager();
        const tracker = makeSelectionTracker({
            current: { path: 'src/a.ts', startLine: 2, endLine: 3 },
            consumePrompt: vi.fn((text: string) => `SELECTION\n\n${text}`),
        });
        const provider = new SidebarProvider({} as any, tm, tracker);
        const { view } = makeWebviewView();
        provider.resolveWebviewView(view, {} as any, {} as any);

        const handler = view.webview.onDidReceiveMessage.mock.calls[0][0] as (m: ClientMessage) => void;
        handler({ type: 'prompt', text: 'explain this' });
        await flush();

        expect(tracker.consumePrompt).toHaveBeenCalledWith('explain this');
        expect(tm.dispatch).toHaveBeenCalledWith({ type: 'prompt', text: 'SELECTION\n\nexplain this' });
    });

    it('does not wrap prompts that carry explicit @-mentions', async () => {
        const tm = makeTabManager();
        const tracker = makeSelectionTracker({
            consumePrompt: vi.fn(() => 'SHOULD NOT APPEAR'),
        });
        const provider = new SidebarProvider({} as any, tm, tracker);
        const { view } = makeWebviewView();
        provider.resolveWebviewView(view, {} as any, {} as any);

        const handler = view.webview.onDidReceiveMessage.mock.calls[0][0] as (m: ClientMessage) => void;
        handler({ type: 'prompt', text: 'look at @src/a.ts', mentions: ['src/a.ts'] });
        await flush();

        expect(tracker.consumePrompt).not.toHaveBeenCalled();
        expect(tm.dispatch).toHaveBeenCalledWith({ type: 'prompt', text: 'look at @src/a.ts', mentions: ['src/a.ts'] });
    });

    it('wraps queued messages with the active selection too', async () => {
        const tm = makeTabManager();
        const tracker = makeSelectionTracker({
            consumePrompt: vi.fn((text: string) => `SELECTION\n\n${text}`),
        });
        const provider = new SidebarProvider({} as any, tm, tracker);
        const { view } = makeWebviewView();
        provider.resolveWebviewView(view, {} as any, {} as any);

        const handler = view.webview.onDidReceiveMessage.mock.calls[0][0] as (m: ClientMessage) => void;
        handler({ type: 'queueMessage', text: 'next step' });
        await flush();

        expect(tracker.consumePrompt).toHaveBeenCalledWith('next step');
        expect(tm.dispatch).toHaveBeenCalledWith({ type: 'queueMessage', text: 'SELECTION\n\nnext step' });
    });

    it('reinstates the selection when dispatch rejects', async () => {
        const tm = makeTabManager();
        (tm.dispatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('still processing'));
        const tracker = makeSelectionTracker({
            current: { path: 'src/a.ts', startLine: 1, endLine: 2 },
            consumePrompt: vi.fn((text: string) => `SELECTION\n\n${text}`),
        });
        const provider = new SidebarProvider({} as any, tm, tracker);
        const { view } = makeWebviewView();
        provider.resolveWebviewView(view, {} as any, {} as any);

        const handler = view.webview.onDidReceiveMessage.mock.calls[0][0] as (m: ClientMessage) => void;
        handler({ type: 'prompt', text: 'explain this' });
        await flush();

        expect(tracker.reinstate).toHaveBeenCalledWith({ path: 'src/a.ts', startLine: 1, endLine: 2 });
    });

    it('routes dismissSelection to the tracker without dispatching', async () => {
        const tm = makeTabManager();
        const tracker = makeSelectionTracker();
        const provider = new SidebarProvider({} as any, tm, tracker);
        const { view } = makeWebviewView();
        provider.resolveWebviewView(view, {} as any, {} as any);

        const handler = view.webview.onDidReceiveMessage.mock.calls[0][0] as (m: ClientMessage) => void;
        handler({ type: 'dismissSelection' });
        await flush();

        expect(tracker.dismiss).toHaveBeenCalledTimes(1);
        expect(tm.dispatch).not.toHaveBeenCalled();
    });

    it('restores the selection chip when the view is re-resolved', async () => {
        const tm = makeTabManager();
        const tracker = makeSelectionTracker({
            current: { path: 'src/a.ts', startLine: 2, endLine: 3 },
        });
        const provider = new SidebarProvider({} as any, tm, tracker);
        const { view, posted } = makeWebviewView();
        provider.resolveWebviewView(view, {} as any, {} as any);
        await flush();

        const selMsgs = posted.filter((m) => m.type === 'selectionChanged');
        expect(selMsgs).toContainEqual({
            type: 'selectionChanged',
            selection: { path: 'src/a.ts', startLine: 2, endLine: 3 },
        });
    });
});
