import { describe, expect, it, vi } from 'vitest';
import { ExtensionUiBridge, terminalText } from '../../../pi/extension-ui';
import { loadPiSdk } from '../../../pi/compat';

const sdk = { Theme: class {} } as any;
const make = () => { const changed = vi.fn(); const notify = vi.fn(); const composer = vi.fn(); const bridge = new ExtensionUiBridge(changed, notify, composer); return { bridge, ui: bridge.createContext(sdk), changed, notify, composer }; };

describe('extension UI bridge', () => {
    it('routes selectors by request id and isolates tabs', async () => {
        const first = make(); const second = make();
        const a = first.ui.select('Pick', ['a', 'b']); const b = second.ui.select('Pick', ['a', 'b']);
        const id = first.bridge.state.dialog!.id;
        second.bridge.respond(id, 'wrong');
        expect(second.bridge.state.dialog).toBeDefined();
        first.bridge.respond(id, 'a'); second.bridge.respond(second.bridge.state.dialog!.id, 'b');
        expect(await a).toBe('a'); expect(await b).toBe('b');
    });
    it('dismisses a native dialog when its signal aborts', async () => {
        const { bridge, ui } = make(); const controller = new AbortController();
        const value = ui.input('Code', undefined, { signal: controller.signal }); controller.abort();
        expect(await value).toBeUndefined(); expect(bridge.state.dialog).toBeUndefined();
    });
    it('renders native component updates, routes keys, and disposes on completion', async () => {
        const { bridge, ui } = make(); const dispose = vi.fn(); let done!: (value: string) => void; let current = 'starting';
        const result = ui.custom<string>((tui, _theme, _keys, finish) => {
            done = finish;
            return { render: () => [current], invalidate() {}, dispose,
                handleInput: data => { current = data; tui.requestRender(); } };
        });
        await vi.waitFor(() => expect(bridge.state.custom).toBeDefined());
        bridge.input(bridge.state.custom!.id, 'connected');
        expect(bridge.state.custom!.lines).toEqual(['connected']);
        done('selected'); expect(await result).toBe('selected'); expect(dispose).toHaveBeenCalledOnce(); expect(bridge.state.custom).toBeUndefined();
    });
    it('clears pending UI on session replacement and preserves editor round trips', async () => {
        const { bridge, ui, composer } = make(); bridge.updateComposer('draft'); ui.pasteToEditor(' + edit');
        expect(ui.getEditorText()).toBe('draft + edit'); expect(composer).toHaveBeenCalledWith('draft + edit');
        ui.setStatus('native', '\x1b[31mconnected\x1b[0m'); ui.setWidget('widget', ['hello']);
        ui.setWorkingVisible(false); ui.setToolsExpanded(true);
        const result = ui.confirm('Continue', 'Message'); bridge.reset();
        expect(bridge.state.workingVisible).toBeUndefined(); expect(bridge.state.toolsExpanded).toBeUndefined();
        expect(await result).toBe(false); expect(bridge.state.statuses).toEqual({}); expect(bridge.state.widgets).toEqual({});
    });
    it('strips control sequences while keeping their readable labels', () => {
        expect(terminalText('\x1b]8;;https://example.test\x07Link\x1b]8;;\x07\x1b[31m text\x1b[0m')).toBe('Link text');
    });

    it('runs the real Pi MCP manager through the sidebar UI, including submenu navigation', async () => {
        const native = await loadPiSdk();
        native.initTheme(undefined, false);
        const events = new Map<string, (...args: any[]) => any>();
        let command: any;
        const pi = {
            on: (name: string, handler: (...args: any[]) => any) => { events.set(name, handler); },
            registerCommand: (_name: string, registered: any) => { command = registered; },
            registerToolRenderer: vi.fn(), getMcpServers: () => [], getActiveTools: () => [], getAllTools: () => [], setActiveTools: vi.fn(), registerTool: vi.fn(),
        };
        native.createMcpExtension({ loadConfig: () => ({ servers: [{ name: 'example', source: 'test', scope: 'extension', config: { command: 'unused', enabled: false } }], errors: [] }) })(pi as any);
        const changed = vi.fn(); const bridge = new ExtensionUiBridge(changed, vi.fn(), vi.fn());
        const ctx = { mode: 'tui', hasUI: true, cwd: process.cwd(), ui: bridge.createContext(native) };
        events.get('session_start')!({}, ctx);
        const result = command.handler('', ctx);
        await vi.waitFor(() => expect(bridge.state.custom?.lines.join('\n')).toContain('example'));
        const id = bridge.state.custom!.id;
        expect(bridge.state.custom!.lines.join('\n')).toContain('disabled');
        bridge.input(id, '\r');
        await vi.waitFor(() => expect(bridge.state.custom?.lines.join('\n')).toContain('Enable'));
        bridge.input(id, '\x1b');
        await vi.waitFor(() => expect(bridge.state.custom?.lines.join('\n')).toContain('MCP servers'));
        bridge.input(id, '\x1b');
        await result;
        expect(bridge.state.custom).toBeUndefined();
    });
});
