import type { ExtensionUIContext, ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent';
import type { ExtensionUiState } from '../shared/protocol';
import type { PiSdk } from './compat';

/** Strip terminal control sequences; extension content is rendered as text in the DOM. */
export function terminalText(text: string): string {
    return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

interface Component { render(width: number): string[]; handleInput?(data: string): void; invalidate?(): void; dispose?(): void; focused?: boolean }
const keyCodes: Record<string, string[]> = {
    'tui.select.confirm': ['\r', '\n'], 'tui.select.cancel': ['\x1b'],
    'tui.select.up': ['\x1b[A'], 'tui.select.down': ['\x1b[B'],
    'app.message.copy': ['\x03'], 'app.interrupt': ['\x1b'],
};
let bridgeSequence = 0;

/** Per-session UI transport, including native text components used by /mcp. */
export class ExtensionUiBridge {
    private readonly prefix = `ui-${++bridgeSequence}`;
    readonly state: ExtensionUiState = { statuses: {}, widgets: {} };
    private sequence = 0;
    private pending?: { id: string; finish(value?: string): void };
    private custom?: { id: string; component?: Component; finish(value?: unknown): void; width: number };
    private editorText = '';
    private terminalHandlers = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>();
    private widgets = new Map<string, Component>();

    constructor(private changed: () => void, private notify: (message: string, type?: string) => void, private composer: (text: string) => void) {}

    updateComposer(text: string): void { this.editorText = text; }
    respond(id: string, value?: string): void { if (this.pending?.id === id) this.pending.finish(value); }
    input(id: string, data: string, width?: number): void {
        if (this.custom?.id !== id || !this.custom.component) return;
        if (width) this.custom.width = Math.max(20, Math.min(160, Math.floor(width)));
        for (const handler of this.terminalHandlers) {
            const result = handler(data);
            if (result?.consume) return;
            data = result?.data ?? data;
        }
        this.custom.component.handleInput?.(data);
        this.renderCustom();
    }
    close(id: string): void {
        if (this.custom?.id === id) {
            this.custom.component?.handleInput?.('\x1b');
            // Native managers use Escape for back/cancel and call done at their root.
            this.renderCustom();
        }
        if (this.pending?.id === id) this.pending.finish();
    }
    reset(): void {
        this.pending?.finish();
        this.custom?.component?.handleInput?.('\x1b');
        this.custom?.finish();
        this.terminalHandlers.clear();
        for (const widget of this.widgets.values()) widget.dispose?.();
        this.widgets.clear();
        this.state.statuses = {};
        this.state.widgets = {};
        delete this.state.workingMessage;
        delete this.state.title;
        delete this.state.workingVisible;
        delete this.state.toolsExpanded;
        this.changed();
    }
    private renderCustom(): void {
        const view = this.custom;
        if (!view?.component) return;
        try {
            this.state.custom = { id: view.id, title: 'menu' in view.component && 'redirectUrl' in view.component ? 'MCP' : 'Pi',
                lines: view.component.render(view.width).map(terminalText) };
            this.changed();
        } catch (error) { this.notify(String(error), 'error'); view.finish(); }
    }
    private dialog(kind: 'select' | 'confirm' | 'input' | 'editor', title: string, extra: Record<string, unknown>, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
        this.pending?.finish();
        const id = `${this.prefix}-dialog-${++this.sequence}`;
        return new Promise(resolve => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (value?: string) => {
                if (this.pending?.id !== id) return;
                if (timer) clearTimeout(timer);
                opts?.signal?.removeEventListener('abort', cancel);
                this.pending = undefined;
                delete this.state.dialog;
                this.changed();
                resolve(value);
            };
            const cancel = () => finish();
            this.pending = { id, finish };
            this.state.dialog = { id, kind, title: terminalText(title), ...extra };
            if (opts?.timeout) timer = setTimeout(cancel, opts.timeout);
            opts?.signal?.addEventListener('abort', cancel, { once: true });
            if (opts?.signal?.aborted) cancel();
            else this.changed();
        });
    }
    createContext(sdk: PiSdk): ExtensionUIContext {
        const identity = (_color: unknown, text: string) => text;
        const theme = Object.assign(Object.create(sdk.Theme.prototype), {
            name: 'vscode', fg: identity, bg: identity, bold: (text: string) => text, italic: (text: string) => text,
            underline: (text: string) => text, inverse: (text: string) => text, strikethrough: (text: string) => text,
            getFgAnsi: () => '', getBgAnsi: () => '',
        });
        const unsupported = () => this.notify('This extension replaces terminal chrome. Use its dialogs or widgets in the sidebar.', 'warning');
        const bridge = this;
        return {
            select: (title, options, opts) => this.dialog('select', title, { options }, opts),
            confirm: async (title, message, opts) => (await this.dialog('confirm', title, { message: terminalText(message) }, opts)) === 'yes',
            input: (title, placeholder, opts) => this.dialog('input', title, { message: placeholder }, opts),
            editor: (title, prefill) => this.dialog('editor', title, { value: prefill ?? '' }),
            notify: (message, type) => this.notify(terminalText(message), type),
            onTerminalInput: handler => { this.terminalHandlers.add(handler); return () => this.terminalHandlers.delete(handler); },
            setStatus: (key, text) => { if (text === undefined) delete this.state.statuses[key]; else this.state.statuses[key] = terminalText(text); this.changed(); },
            setWidget: (key: string, content: unknown, options?: { placement?: 'aboveEditor' | 'belowEditor' }) => {
                this.widgets.get(key)?.dispose?.();
                this.widgets.delete(key);
                if (content === undefined) delete this.state.widgets[key];
                else if (Array.isArray(content)) this.state.widgets[key] = { lines: content.map(line => terminalText(String(line))), placement: options?.placement ?? 'aboveEditor' };
                else if (typeof content === 'function') {
                    const render = () => {
                        const component = this.widgets.get(key);
                        if (!component) return;
                        try { this.state.widgets[key] = { lines: component.render(48).map(terminalText), placement: options?.placement ?? 'aboveEditor' }; this.changed(); }
                        catch (error) { this.notify(String(error), 'error'); }
                    };
                    try {
                        const component = content({ requestRender: () => queueMicrotask(render), terminal: { rows: 24, columns: 48 } }, theme) as Component;
                        this.widgets.set(key, component); render();
                    } catch (error) { this.notify(String(error), 'error'); }
                } else unsupported();
                this.changed();
            },
            setWorkingMessage: message => { this.state.workingMessage = message && terminalText(message); this.changed(); },
            setWorkingVisible: visible => { this.state.workingVisible = visible; this.changed(); },
            setWorkingIndicator: options => { this.state.workingVisible = options?.frames?.length !== 0; this.changed(); },
            setHiddenThinkingLabel: () => {},
            setFooter: factory => { if (factory) unsupported(); }, setHeader: factory => { if (factory) unsupported(); },
            setTitle: title => { this.state.title = terminalText(title); this.changed(); },
            custom: async <T>(factory: Parameters<ExtensionUIContext['custom']>[0]): Promise<T> => {
                this.custom?.finish();
                const id = `${this.prefix}-custom-${++this.sequence}`;
                return new Promise<T>((resolve, reject) => {
                    let completed = false;
                    const finish = (value?: unknown, error?: unknown) => {
                        if (completed) return;
                        completed = true;
                        if (this.custom?.id === id) {
                            this.custom.component?.dispose?.();
                            this.custom = undefined;
                            delete this.state.custom;
                            this.changed();
                        }
                        if (error !== undefined) reject(error);
                        else resolve(value as T);
                    };
                    this.custom = { id, finish, width: 48 };
                    const tui = { requestRender: () => queueMicrotask(() => { if (this.custom?.id === id) this.renderCustom(); }),
                        terminal: { rows: 24, columns: 48 }, setFocus: (component: Component) => { component.focused = true; } };
                    const bindings = { matches: (data: string, action: string) => (keyCodes[action] ?? []).includes(data), getKeys: (action: string) => action === 'tui.select.cancel' ? ['escape'] : action === 'tui.select.confirm' ? ['enter'] : [] };
                    Promise.resolve().then(() => factory(tui as any, theme, bindings as any, finish)).then(component => {
                        if (completed || this.custom?.id !== id) { component.dispose?.(); return; }
                        this.custom.component = component;
                        (component as Component).focused = true;
                        this.renderCustom();
                    }, error => { finish(undefined, error); this.notify(String(error), 'error'); });
                });
            },
            pasteToEditor: text => { this.editorText += text; this.composer(this.editorText); },
            setEditorText: text => { this.editorText = text; this.composer(text); }, getEditorText: () => this.editorText,
            addAutocompleteProvider: unsupported, setEditorComponent: factory => { if (factory) unsupported(); }, getEditorComponent: () => undefined,
            theme, getAllThemes: () => [], getTheme: () => theme, setTheme: () => ({ success: false, error: 'The sidebar follows the VS Code theme.' }),
            getToolsExpanded: () => this.state.toolsExpanded ?? false, setToolsExpanded: expanded => { bridge.state.toolsExpanded = expanded; bridge.changed(); },
        };
    }
}
