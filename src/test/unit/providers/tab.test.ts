import { describe, it, expect, vi } from 'vitest';
import { TabManager, type Tab, type TabFactory, type TabManagerHooks } from '../../../providers/tab';
import { EventRouter } from '../../../pi/events';
import { DiffManager } from '../../../providers/diff';
import { CheckpointManager } from '../../../providers/checkpoint';

function makeTab(overrides: Partial<Tab['session']> = {}): Tab {
    const events = new EventRouter();
    const session = {
        events,
        session: undefined,
        serializeState: () => ({
            messages: [],
            isStreaming: false,
            tools: [],
        }),
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
        diffManager,
        checkpointManager,
    };
}

function makeHooks(overrides: Partial<TabManagerHooks> = {}): TabManagerHooks {
    return {
        post: vi.fn(),
        setContext: vi.fn(),
        openFile: vi.fn(),
        showMessage: vi.fn(),
        confirmDialog: vi.fn(async () => false),
        openSettings: vi.fn(),
        ...overrides,
    };
}

describe('TabManager', () => {
    it('initializes with a single active tab and emits initial state', async () => {
        const factory: TabFactory = { create: vi.fn(async () => makeTab()) };
        const hooks = makeHooks();
        const manager = new TabManager(factory, hooks);
        await manager.initialize();

        expect(factory.create).toHaveBeenCalledTimes(1);
        expect(manager.activeTab).toBeDefined();
        expect(manager.getState().activeTabId).toBe(manager.activeTab!.id);
        expect(manager.getState().tabs).toHaveLength(1);
    });

    it('creates additional tabs on createTab and switches active tab', async () => {
        const factory: TabFactory = { create: vi.fn(async () => makeTab()) };
        const hooks = makeHooks();
        const manager = new TabManager(factory, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'createTab' });
        expect(factory.create).toHaveBeenCalledTimes(2);
        expect(manager.getState().tabs).toHaveLength(2);

        const firstTabId = manager.getState().tabs![0].id;
        await manager.dispatch({ type: 'switchTab', tabId: firstTabId });
        expect(manager.activeTab!.id).toBe(firstTabId);
    });

    it('fires onStateChange when a state-changing dispatch occurs', async () => {
        const factory: TabFactory = { create: vi.fn(async () => makeTab()) };
        const hooks = makeHooks();
        const manager = new TabManager(factory, hooks);
        await manager.initialize();

        const listener = vi.fn();
        manager.onStateChange(listener);

        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(listener).toHaveBeenCalled();
    });

    it('does not fire onStateChange for pure query messages', async () => {
        const factory: TabFactory = { create: vi.fn(async () => makeTab()) };
        const hooks = makeHooks();
        const manager = new TabManager(factory, hooks);
        await manager.initialize();

        const listener = vi.fn();
        manager.onStateChange(listener);

        await manager.dispatch({ type: 'getModels' });
        expect(listener).not.toHaveBeenCalled();
        expect(hooks.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'models' } as any));
    });

    it('dispatches pure UI side effects through the hooks', async () => {
        const factory: TabFactory = { create: vi.fn(async () => makeTab()) };
        const hooks = makeHooks();
        const manager = new TabManager(factory, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'openFile', filePath: '/tmp/a.txt' });
        expect(hooks.openFile).toHaveBeenCalledWith('/tmp/a.txt');

        await manager.dispatch({ type: 'openSettings' });
        expect(hooks.openSettings).toHaveBeenCalled();
    });

    it('gets the current agentEvent to the webview on a message for the active tab', async () => {
        const factory: TabFactory = { create: vi.fn(async () => makeTab()) };
        const hooks = makeHooks();
        const manager = new TabManager(factory, hooks);
        await manager.initialize();

        manager.activeTab!.session.events.dispatch({ type: 'agent_start' } as any);
        expect(hooks.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'agentEvent' } as any));
        expect(hooks.setContext).toHaveBeenCalledWith('pi-agent.isStreaming', true);
    });

    it('dispose cleans up all tabs and subscriptions', async () => {
        const factory: TabFactory = { create: vi.fn(async () => makeTab()) };
        const hooks = makeHooks();
        const manager = new TabManager(factory, hooks);
        await manager.initialize();
        await manager.dispatch({ type: 'createTab' });

        manager.dispose();
        expect(manager.getState().tabs).toBeUndefined();
    });
});
