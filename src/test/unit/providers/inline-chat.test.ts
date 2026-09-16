import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InlineChatManager, type InlineChatDeps } from '../../../providers/inline-chat';
import { TabManager, type Tab, type TabFactory, type TabManagerHooks } from '../../../providers/tab';
import { DiffManager } from '../../../providers/diff';
import { CheckpointManager } from '../../../providers/checkpoint';
import { EventRouter } from '../../../pi/events';

const h = vi.hoisted(() => ({
    workRoot: '',
    activeEditor: undefined as any,
    visibleEditors: [] as any[],
    activeEditorCbs: [] as ((e: any) => void)[],
    docChangeCbs: [] as ((e: any) => void)[],
    inputBox: undefined as any,
}));

vi.mock('vscode', () => ({
    window: {
        get activeTextEditor() { return h.activeEditor; },
        get visibleTextEditors() { return h.visibleEditors; },
        createInputBox: () => h.inputBox,
        createTextEditorDecorationType: (options: any) => ({ options, dispose: () => {} }),
        onDidChangeActiveTextEditor: (cb: any) => {
            h.activeEditorCbs.push(cb);
            return {
                dispose: () => {
                    const i = h.activeEditorCbs.indexOf(cb);
                    if (i >= 0) h.activeEditorCbs.splice(i, 1);
                },
            };
        },
        createStatusBarItem: () => ({
            text: '', tooltip: '', command: '',
            show: vi.fn(), hide: vi.fn(), dispose: () => {},
        }),
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
    },
    workspace: {
        get workspaceFolders() { return [{ uri: { fsPath: h.workRoot } }]; },
        asRelativePath: (uri: any) =>
            uri.fsPath.startsWith(h.workRoot + '/')
                ? uri.fsPath.slice(h.workRoot.length + 1)
                : uri.fsPath,
        onDidChangeTextDocument: (cb: any) => {
            h.docChangeCbs.push(cb);
            return {
                dispose: () => {
                    const i = h.docChangeCbs.indexOf(cb);
                    if (i >= 0) h.docChangeCbs.splice(i, 1);
                },
            };
        },
        getConfiguration: () => ({ get: () => undefined, has: () => false, update: () => {} }),
        openTextDocument: async () => ({}),
        registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
    },
    commands: {
        executeCommand: async () => undefined,
        registerCommand: () => ({ dispose: () => {} }),
    },
    Uri: {
        file: (p: string) => ({ fsPath: p }),
        parse: (s: string) => ({ toString: () => s }),
    },
    Range: class {
        constructor(public a: number, public b: number, public c: number, public d: number) {}
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    EventEmitter: class { fire = () => {}; dispose = () => {}; event = () => () => {}; },
    Disposable: { from: () => ({ dispose: () => {} }) },
}));

function makeTab(overrides: Partial<Tab['session']> = {}): Tab {
    const events = new EventRouter();
    const session = {
        events,
        session: undefined,
        getActiveToolNames: vi.fn(() => ['read', 'edit', 'bash', 'write']),
        setActiveToolsByName: vi.fn(),
        serializeState: () => ({ messages: [], isStreaming: false, tools: [] }),
        getSessionId: () => undefined,
        getSessionName: () => undefined,
        getContextUsage: () => undefined,
        getMessages: () => [],
        setMessages: () => {},
        getModels: () => [],
        getCurrentModel: () => undefined,
        getThinkingLevel: () => undefined,
        getAvailableThinkingLevels: () => [],
        supportsThinking: () => false,
        getSessionStats: () => undefined,
        setModel: vi.fn(async () => {}),
        setThinkingLevel: () => {},
        prompt: vi.fn(async () => {}),
        supportsImages: () => false,
        newSession: vi.fn(async () => {}),
        loadSession: vi.fn(async () => {}),
        setToolApprovalHandler: () => {},
        followUp: vi.fn(async () => {}),
        getFollowUpMessages: () => [],
        replaceFollowUpMessages: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
        showModelPicker: vi.fn(async () => {}),
        cycleThinkingLevel: () => 'off',
        compact: vi.fn(async () => {}),
        getSkills: () => [],
        dispose: vi.fn(async () => {}),
        ...overrides,
    } as any;
    const checkpointManager = new CheckpointManager();
    const diffManager = new DiffManager(session, checkpointManager);
    return {
        id: '',
        name: 'New Agent',
        session,
        checkpointManager,
        diffManager,
    } as unknown as Tab;
}

function makeHooks(overrides: Partial<TabManagerHooks> = {}): TabManagerHooks {
    return {
        post: vi.fn(),
        setContext: vi.fn(),
        openFile: vi.fn(),
        showMessage: vi.fn(),
        confirmDialog: vi.fn(async () => false),
        openSettings: vi.fn(),
        getCwd: vi.fn(() => h.workRoot),
        applyPreview: vi.fn(async () => ({
            previewId: 'ap-1', targetPath: '/work/a.ts', isNew: false,
            diff: '+code', addedLines: 1, removedLines: 0, code: 'code',
        })),
        applyConfirm: vi.fn(async () => ({ ok: true })),
        applyCancel: vi.fn(),
        getCompactionThreshold: vi.fn(() => 80),
        searchFiles: vi.fn(async () => []),
        searchSymbols: vi.fn(async () => []),
        resolveMentionPath: vi.fn(async () => null),
        readTextFile: vi.fn(async () => null),
        resolveDroppedFiles: vi.fn(async () => []),
        ...overrides,
    };
}

function makeManager(tm: TabManager, deps: Partial<InlineChatDeps> = {}): {
    manager: InlineChatManager; deps: InlineChatDeps;
} {
    const fullDeps: InlineChatDeps = {
        getTabManager: () => tm,
        showMessage: vi.fn(),
        confirmDialog: vi.fn(async () => true),
        setContext: vi.fn(),
        ...deps,
    };
    return { manager: new InlineChatManager(fullDeps), deps: fullDeps };
}

function makeEditor(fileContent: string, opts: {
    file?: string; isDirty?: boolean; selection?: any; selectionCode?: string;
} = {}): any {
    const p = opts.file ?? path.join(h.workRoot, 'a.ts');
    let dirty = opts.isDirty ?? false;
    const doc = {
        uri: { fsPath: p },
        getText: (range?: any) => {
            if (range && !range.isEmpty && opts.selectionCode !== undefined) {
                return opts.selectionCode;
            }
            // Clean buffers mirror disk (tool writes land on disk directly).
            try {
                return fs.readFileSync(p, 'utf-8');
            } catch {
                return fileContent;
            }
        },
        get isDirty() { return dirty; },
        set isDirty(v: boolean) { dirty = v; },
        languageId: 'ts',
        lineCount: fileContent.split('\n').length,
        save: vi.fn(async () => { dirty = false; }),
    };
    return {
        document: doc,
        selection: opts.selection ?? {
            isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 },
        },
        setDecorations: vi.fn(),
    };
}

function makeInputBox(value: string): any {
    let acceptCb: (() => void) | undefined;
    let hideCb: (() => void) | undefined;
    return {
        value, title: '', placeholder: '',
        onDidAccept: (cb: () => void) => { acceptCb = cb; },
        onDidHide: (cb: () => void) => { hideCb = cb; },
        show: () => {},
        dispose: () => { hideCb?.(); },
        accept: () => acceptCb?.(),
    };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('InlineChatManager (C13)', () => {
    let workRoot = '';
    let file = '';
    let tm: TabManager;
    let tab: Tab;
    let manager: InlineChatManager;
    let deps: InlineChatDeps;

    beforeEach(async () => {
        workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-inline-'));
        h.workRoot = workRoot;
        file = path.join(workRoot, 'a.ts');
        fs.writeFileSync(file, 'A\n');
        h.activeEditor = undefined;
        h.visibleEditors = [];
        h.activeEditorCbs = [];
        h.docChangeCbs = [];
        h.inputBox = undefined;

        tab = makeTab();
        tm = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await tm.initialize();
        const made = makeManager(tm);
        manager = made.manager;
        deps = made.deps;
    });

    afterEach(() => {
        manager.dispose();
        fs.rmSync(workRoot, { recursive: true, force: true });
    });

    async function startRound(instruction: string, editorOpts: Parameters<typeof makeEditor>[1] = {}) {
        const editor = makeEditor('A\n', editorOpts);
        h.activeEditor = editor;
        h.visibleEditors = [editor];
        h.inputBox = makeInputBox(instruction);
        const running = manager.start();
        // Dirty-save paths await confirmDialog before reaching the input box;
        // give start() time to get there before accepting.
        await flush();
        h.inputBox.accept();
        await running;
        return editor;
    }

    function runEditTool(newContent: string): void {
        tab.session.events.dispatch({
            type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args: { path: 'a.ts' },
        } as any);
        fs.writeFileSync(file, newContent);
        tab.session.events.dispatch({
            type: 'tool_execution_end', toolCallId: 't1', toolName: 'edit',
            isError: false, result: 'ok',
        } as any);
    }

    it('dispatches the prompt through the active tab and tracks the round', async () => {
        const editor = await startRound('make it better');

        expect(tab.session.prompt).toHaveBeenCalledTimes(1);
        const sent = vi.mocked(tab.session.prompt).mock.calls[0][0] as string;
        expect(sent.startsWith('make it better')).toBe(true);
        expect(sent).toContain('a.ts');
        expect(sent).toContain('A');
        expect(tm.getTurnCounter(tm.activeTab!.id)).toBe(1);
        expect(manager.active).toBe(true);
        expect(deps.setContext).toHaveBeenCalledWith('pi-agent.inlinePending', false);
        void editor;
    });

    it('builds a selection-scoped context with line range', async () => {
        const selection = {
            isEmpty: false,
            start: { line: 2, character: 0 },
            end: { line: 4, character: 3 },
        };
        await startRound('refactor this', { selection, selectionCode: 'SEL CODE' });

        const sent = vi.mocked(tab.session.prompt).mock.calls[0][0] as string;
        expect(sent).toContain('a.ts:3-5');
        expect(sent).toContain('SEL CODE');
    });

    it('previews changes with decorations and enters pending review on settle', async () => {
        const editor = await startRound('make it better');

        runEditTool('B\nC\n');
        await flush();

        expect(editor.setDecorations).toHaveBeenCalled();
        // The trailing setDecorations call may be the empty clear of the other
        // decoration type — compare the last call that actually paints lines.
        const painted = (): any[][] =>
            (editor.setDecorations as any).mock.calls.filter((c: any[]) => c[1].length > 0);
        const ranges = painted().at(-1)![1] as any[];
        expect(ranges).toHaveLength(1);
        expect(ranges[0].a).toBe(0);
        expect(ranges[0].c).toBe(1);

        tab.session.events.dispatch({ type: 'agent_settled' } as any);

        expect(deps.setContext).toHaveBeenLastCalledWith('pi-agent.inlinePending', true);
        // Decorations restyled to the stale (grey) variant after settle.
        const lastDeco = painted().at(-1)![0];
        expect(String((lastDeco as any).options.backgroundColor)).toContain('128,128,128');
    });

    it('accept keeps changes and clears the pending state', async () => {
        await startRound('make it better');
        runEditTool('B\nC\n');
        await flush();
        tab.session.events.dispatch({ type: 'agent_settled' } as any);

        manager.accept();

        expect(fs.readFileSync(file, 'utf-8')).toBe('B\nC\n');
        expect(manager.active).toBe(false);
        expect(deps.setContext).toHaveBeenLastCalledWith('pi-agent.inlinePending', false);
        expect(deps.showMessage).toHaveBeenCalledWith(expect.stringContaining('kept'));
    });

    it('discard rolls the whole round back through the checkpoint chain', async () => {
        await startRound('make it better');
        runEditTool('B\nC\n');
        await flush();
        tab.session.events.dispatch({ type: 'agent_settled' } as any);

        await manager.discard();

        expect(fs.readFileSync(file, 'utf-8')).toBe('A\n');
        expect(manager.active).toBe(false);
        expect(deps.confirmDialog).toHaveBeenCalledWith(expect.stringContaining('Discard all changes'));
        expect(deps.showMessage).toHaveBeenCalledWith(expect.stringContaining('reverted'));
    });

    it('warns about manual edits before discarding', async () => {
        const editor = await startRound('make it better');
        runEditTool('B\nC\n');
        await flush();
        tab.session.events.dispatch({ type: 'agent_settled' } as any);

        editor.document.isDirty = true;
        await manager.discard();

        expect(deps.confirmDialog).toHaveBeenCalledWith(expect.stringContaining('also revert'));
        expect(fs.readFileSync(file, 'utf-8')).toBe('A\n');
    });

    it('notifies once about manual edits during generation', async () => {
        await startRound('make it better');

        h.docChangeCbs.forEach((cb) => cb({
            document: { uri: { fsPath: file }, isDirty: true },
        }));
        h.docChangeCbs.forEach((cb) => cb({
            document: { uri: { fsPath: file }, isDirty: true },
        }));

        expect(deps.showMessage).toHaveBeenCalledTimes(1);
        expect(deps.showMessage).toHaveBeenCalledWith(expect.stringContaining('conflict'));
    });

    it('finishes silently when the round produced no changes', async () => {
        await startRound('explain, do not edit');
        tab.session.events.dispatch({ type: 'agent_settled' } as any);

        expect(manager.active).toBe(false);
        expect(deps.setContext).toHaveBeenLastCalledWith('pi-agent.inlinePending', false);
        expect(deps.setContext).not.toHaveBeenCalledWith('pi-agent.inlinePending', true);
    });

    it('rejects a second round while one is active', async () => {
        await startRound('first');

        h.inputBox = makeInputBox('second');
        await manager.start();

        expect(deps.showMessage).toHaveBeenCalledWith(expect.stringContaining('already in progress'));
        expect(tab.session.prompt).toHaveBeenCalledTimes(1);
    });

    it('refuses to start while the tab is streaming', async () => {
        tab.session.events.dispatch({ type: 'agent_start' } as any);

        await manager.start();

        expect(deps.showMessage).toHaveBeenCalledWith(expect.stringContaining('still processing'));
        expect(h.inputBox).toBeUndefined();
        expect(manager.active).toBe(false);
    });

    it('requires saving a dirty buffer before invoking', async () => {
        const editor = await startRound('go', { isDirty: true });

        expect(editor.document.save).toHaveBeenCalled();
        expect(manager.active).toBe(true);
    });

    it('aborts the invocation when saving is declined', async () => {
        (deps.confirmDialog as ReturnType<typeof vi.fn>).mockResolvedValue(false);
        const editor = await startRound('go', { isDirty: true });

        expect(editor.document.save).not.toHaveBeenCalled();
        expect(manager.active).toBe(false);
    });

    it('reports a failed dispatch and clears the round', async () => {
        vi.mocked(tab.session.prompt).mockRejectedValueOnce(new Error('no model'));

        await startRound('make it better');

        expect(manager.active).toBe(false);
        // Raw errors are humanized (T17): the copy wraps the raw detail.
        expect(deps.showMessage).toHaveBeenCalledWith(expect.stringContaining('no model'));
    });

    it('refuses to discard while the round tab is streaming again', async () => {
        await startRound('make it better');
        runEditTool('B\nC\n');
        await flush();
        tab.session.events.dispatch({ type: 'agent_settled' } as any);
        tab.session.events.dispatch({ type: 'agent_start' } as any);

        await manager.discard();

        expect(deps.showMessage).toHaveBeenCalledWith(expect.stringContaining('still processing'));
        expect(deps.confirmDialog).not.toHaveBeenCalled();
        expect(fs.readFileSync(file, 'utf-8')).toBe('B\nC\n');
    });

    it('reapplies decorations when the active editor changes', async () => {
        const editor = await startRound('make it better');
        runEditTool('B\nC\n');
        await flush();

        h.visibleEditors = [];
        h.activeEditorCbs.forEach((cb) => cb(undefined));
        h.visibleEditors = [editor];
        h.activeEditorCbs.forEach((cb) => cb(editor));

        const decoCalls = editor.setDecorations.mock.calls.length;
        expect(decoCalls).toBeGreaterThanOrEqual(2);
    });
});
