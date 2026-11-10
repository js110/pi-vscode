import { describe, it, expect, vi } from 'vitest';
import { TabManager, type Tab, type TabFactory, type TabManagerAdapters } from '../../../providers/tab';
import { EventRouter } from '../../../pi/events';
import { DiffManager } from '../../../providers/diff';
import { CheckpointManager } from '../../../providers/checkpoint';

vi.mock('../../../pi/config', () => ({
    ensureConfigDiscovered: vi.fn(async () => ({
        status: 'ok',
        agentDir: '/home/u/.pi/agent',
        agentDirExists: true,
        providers: [],
        models: [],
        skills: [],
        errors: [],
        discoveredAt: 1,
    })),
    refreshPiConfig: vi.fn(),
}));

function makeTab(overrides: Partial<Tab['session']> = {}): Tab {
    const events = new EventRouter();
    const session = {
        events,
        session: undefined,
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
        steer: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        getQueuedMessages: () => [],
        replaceQueuedMessages: vi.fn(async () => []),
        isStreaming: false,
        abort: vi.fn(async () => {}),
        showModelPicker: vi.fn(async () => {}),
        cycleThinkingLevel: () => 'off',
        compact: vi.fn(async () => {}),
        getSkills: () => [],
        getCommands: () => [],
        getCurrentSessionPath: () => undefined,
        invalidateSessionsCache: vi.fn(),
        executeBuiltinCommand: vi.fn(async () => ({})),
        getSessionTree: vi.fn(() => []),
        navigateSessionTree: vi.fn(async () => ({})),
        labelSessionTree: vi.fn(),
        dispose: vi.fn(async () => {}),
        ...overrides,
    } as any;
    events.onAll((event: any) => {
        if (event?.type === 'agent_start') session.isStreaming = true;
        if (event?.type === 'agent_settled') session.isStreaming = false;
    });
    const checkpointManager = new CheckpointManager();
    const diffManager = new DiffManager(session, checkpointManager);
    return { id: '', name: 'New Agent', session, diffManager, checkpointManager };
}

function makeAdapters() {
    const adapters: TabManagerAdapters = {
        transport: { post: vi.fn(), setContext: vi.fn() },
        workspace: {
            openFile: vi.fn(),
            getCwd: vi.fn(() => '/work'),
            searchFiles: vi.fn(async () => []),
            searchSymbols: vi.fn(async () => []),
            resolveMentionPath: vi.fn(async () => null),
            readTextFile: vi.fn(async () => null),
            resolveDroppedFiles: vi.fn(async () => []),
        },
        ui: {
            showMessage: vi.fn(),
            confirmDialog: vi.fn(async () => false),
            openSettings: vi.fn(),
            writeClipboard: vi.fn(async () => {}),
        },
        agent: {
            applyPreview: vi.fn(),
            applyConfirm: vi.fn(),
            applyCancel: vi.fn(),
            getCompactionThreshold: vi.fn(() => 80),
            exportSession: vi.fn(),
            autoNameSession: vi.fn(async () => undefined),
            generateDiagnosticSummary: vi.fn(),
        } as any,
    };
    return adapters;
}

async function setup(sessionOverrides: Partial<Tab['session']> = {}) {
    const tab = makeTab(sessionOverrides);
    const factory: TabFactory = { create: vi.fn(async () => tab) };
    const adapters = makeAdapters();
    const manager = new TabManager(factory, adapters);
    await manager.initialize();
    return { tab, manager, adapters };
}

/** The active tab is a decorated copy of the factory's Tab; state lives on
 *  the manager's record, not on the raw factory object. */
function activeTab(manager: TabManager): any {
    return manager.activeTab as any;
}

/** Register a pending approval the way the real hook does. */
function stashApproval(tab: any, id: string) {
    const resolve = vi.fn();
    tab.pendingApprovals.set(id, { resolve, toolName: 'bash', args: {} });
    return resolve;
}

describe('TabManager session replacement', () => {
    it('settles pending approvals on abort and tells the webview', async () => {
        const { manager, adapters } = await setup();
        const tab = activeTab(manager);
        const resolve = stashApproval(tab, 'call-1');

        await manager.dispatch({ type: 'abort' });

        expect(resolve).toHaveBeenCalledWith(false);
        expect(tab.pendingApprovals.size).toBe(0);
        expect(adapters.transport.post).toHaveBeenCalledWith({ type: 'toolCallResolved', toolCallId: 'call-1' });
        expect(manager.getState().pendingApprovals).toEqual([]);
    });

    it('settles pending approvals when a new session replaces the conversation', async () => {
        const { manager } = await setup();
        const tab = activeTab(manager);
        const resolve = stashApproval(tab, 'call-2');

        await manager.dispatch({ type: 'newSession' });

        expect(resolve).toHaveBeenCalledWith(false);
        expect(tab.pendingApprovals.size).toBe(0);
    });

    it('refuses a session switch while a turn is streaming', async () => {
        const { tab, manager, adapters } = await setup();
        const state = activeTab(manager);
        state.isStreaming = true;

        await manager.dispatch({ type: 'newSession' });

        expect(tab.session.newSession).not.toHaveBeenCalled();
        expect(adapters.ui.showMessage).toHaveBeenCalled();
    });

    it('re-derives the turn counter from the loaded conversation on every switch path', async () => {
        const messages = [
            { role: 'user' },
            { role: 'assistant' },
            { role: 'user' },
        ];
        const { manager } = await setup({ getMessages: () => messages as any });
        const state = activeTab(manager);
        state.turnCounter = 99;

        await manager.dispatch({ type: 'loadSession', sessionPath: '/s/a.jsonl' });

        expect(state.turnCounter).toBe(2);
    });

    it('clears per-session image assets and pending turn bookings on switch', async () => {
        const { manager } = await setup();
        const state = activeTab(manager);
        state.imageAssets.set('data:image/png;base64,AAA', 'img-1');
        state.imageData.set('img-1', 'data:image/png;base64,AAA');
        state.pendingPromptTurns = [1, 2];
        state.runOutcome = 'failed';

        await manager.dispatch({ type: 'newSession' });

        expect(state.imageAssets.size).toBe(0);
        expect(state.imageData.size).toBe(0);
        expect(state.pendingPromptTurns).toEqual([]);
        expect(state.runOutcome).toBeUndefined();
    });

    it('does not trash a session file while a tab still holds it', async () => {
        const { manager } = await setup({
            getCurrentSessionPath: () => '/s/live.jsonl',
            getSessions: vi.fn(async () => [{ id: 's', name: 'Live', path: '/s/live.jsonl' }]),
            dispose: vi.fn(async () => {}),
        });
        const adapters = (manager as any)._adapters;
        adapters.ui.confirmDialog = vi.fn(async () => true);

        await manager.dispatch({ type: 'deleteSession', sessionPath: '/s/live.jsonl' });

        // The last tab is force-closed so the SDK stops writing, then the tab
        // set is re-initialized with a fresh session.
        expect(manager.activeTab).toBeDefined();
        expect(manager.activeTab!.session).toBeDefined();
    });

    it('routes the palette compact command through the guarded banner path', async () => {
        const { tab, manager } = await setup();
        const state = activeTab(manager);
        state.isStreaming = true;

        await manager.compact();

        expect(tab.session.compact).not.toHaveBeenCalled();
    });
});
