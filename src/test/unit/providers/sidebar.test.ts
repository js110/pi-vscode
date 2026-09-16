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

describe('SidebarProvider webview lifecycle', () => {
    it('does not tear down the TabManager when the webview is disposed', () => {
        // VS Code destroys sidebar webviews whenever the view is hidden; the
        // TabManager (and its sessions) must survive hide/show cycles.
        const tm = makeTabManager();
        const provider = new SidebarProvider({} as any, tm);
        const { view, fireDispose } = makeWebviewView();

        provider.resolveWebviewView(view, {} as any, {} as any);
        fireDispose();

        expect(tm.dispose).not.toHaveBeenCalled();
    });

    it('re-posts the full conversation state when the view is re-resolved', async () => {
        const tm = makeTabManager();
        const provider = new SidebarProvider({} as any, tm);
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
        const provider = new SidebarProvider({} as any, tm);
        const { view } = makeWebviewView();
        provider.resolveWebviewView(view, {} as any, {} as any);

        const handler = view.webview.onDidReceiveMessage.mock.calls[0][0] as (m: ClientMessage) => void;
        handler({ type: 'prompt', text: 'hello' });
        await flush();

        expect(tm.dispatch).toHaveBeenCalledWith({ type: 'prompt', text: 'hello' });
    });
});
