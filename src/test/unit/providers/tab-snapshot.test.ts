import { describe, it, expect, vi, afterEach } from 'vitest';
import { TabManager, type Tab, type TabFactory, type TabManagerHooks } from '../../../providers/tab';
import { EventRouter } from '../../../pi/events';
import { DiffManager } from '../../../providers/diff';
import { CheckpointManager } from '../../../providers/checkpoint';

const PNG = 'iVBORw0KGgo=';
const JPEG = '/9j/4AAQ';

const managers: TabManager[] = [];

afterEach(() => {
    for (const manager of managers.splice(0)) {
        void manager.dispose();
    }
});

function makeTab(overrides: Partial<Tab['session']> = {}): Tab {
    const events = new EventRouter();
    const fake = {
        events,
        messages: [] as any[],
        serializeStateCalls: 0,
    };
    const session = {
        events,
        session: undefined,
        serializeState: (includeMessages = true) => {
            fake.serializeStateCalls++;
            const base: any = { isStreaming: false, tools: [] };
            if (includeMessages) {
                base.messages = fake.messages.map((m: any) => JSON.parse(JSON.stringify(m)));
            }
            return base;
        },
        getSessionId: () => undefined,
        getSessionName: () => undefined,
        getContextUsage: () => undefined,
        getMessages: () => fake.messages,
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
        getCurrentSessionPath: () => undefined,
        setToolApprovalHandler: () => {},
        followUp: vi.fn(async () => {}),
        getFollowUpMessages: () => [],
        replaceFollowUpMessages: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
        abortBash: vi.fn(),
        showModelPicker: vi.fn(async () => {}),
        cycleThinkingLevel: () => 'off',
        compact: vi.fn(async () => {}),
        getSkills: () => [],
        dispose: vi.fn(async () => {}),
        ...overrides,
        _fake: fake,
    } as any;
    const checkpointManager = new CheckpointManager();
    const diffManager = new DiffManager(session, checkpointManager);
    return { id: '', name: 'New Agent', session, diffManager, checkpointManager };
}

function makeHooks(overrides: Partial<TabManagerHooks> = {}): TabManagerHooks {
    return {
        post: vi.fn(),
        setContext: vi.fn(),
        openFile: vi.fn(),
        showMessage: vi.fn(),
        confirmDialog: vi.fn(async () => false),
        openSettings: vi.fn(),
        writeClipboard: vi.fn(async () => {}),
        getCwd: vi.fn(() => '/work'),
        applyPreview: vi.fn(async () => null),
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

function makeManager(sessionOverrides: Partial<Tab['session']> = {}) {
    const factory: TabFactory = { create: vi.fn(async () => makeTab(sessionOverrides)) };
    const hooks = makeHooks();
    const manager = new TabManager(factory, hooks);
    managers.push(manager);
    return { manager, hooks, factory };
}

function fakeOf(manager: TabManager): { messages: any[]; serializeStateCalls: number } {
    return (manager.activeTab!.session as any)._fake;
}

describe('getSnapshot message increment', () => {
    it('sends messages on the first snapshot and omits them when nothing changed', async () => {
        const { manager } = makeManager();
        await manager.initialize();

        const first = manager.getSnapshot();
        expect(first.state.messages).toEqual([]);

        const second = manager.getSnapshot();
        expect(second.state.messages).toBeUndefined();
        expect(second.images).toBeUndefined();
    });

    it('re-sends messages after a message_end event', async () => {
        const { manager } = makeManager();
        await manager.initialize();
        const session = manager.activeTab!.session as any;

        manager.getSnapshot();
        session.events.dispatch({ type: 'message_end', message: { role: 'assistant', content: 'x' } });

        expect(manager.getSnapshot().state.messages).toBeDefined();
    });

    it('a user message_end marks messages dirty too', async () => {
        const { manager } = makeManager();
        await manager.initialize();
        const session = manager.activeTab!.session as any;

        manager.getSnapshot();
        session.events.dispatch({ type: 'message_end', message: { role: 'user', content: 'hi' } });

        expect(manager.getSnapshot().state.messages).toBeDefined();
    });

    it('re-sends messages after an accepted compaction', async () => {
        const { manager } = makeManager();
        await manager.initialize();

        manager.getSnapshot();
        await manager.dispatch({ type: 'compactionAccept' });

        expect(manager.getSnapshot().state.messages).toBeDefined();
    });

    it('re-sends messages on a forced snapshot', async () => {
        const { manager } = makeManager();
        await manager.initialize();

        manager.getSnapshot();
        const forced = manager.getSnapshot(true);

        expect(forced.state.messages).toEqual([]);
    });

    it('re-sends messages when the active tab switches', async () => {
        const { manager } = makeManager();
        await manager.initialize();
        const firstTabId = manager.activeTab!.id;

        manager.getSnapshot();
        await manager.dispatch({ type: 'createTab' });
        expect(manager.getSnapshot().state.messages).toBeDefined();

        manager.getSnapshot();
        await manager.dispatch({ type: 'switchTab', tabId: firstTabId });
        expect(manager.getSnapshot().state.messages).toBeDefined();
    });

    it('re-sends messages after a session switch', async () => {
        const { manager } = makeManager();
        await manager.initialize();

        manager.getSnapshot();
        await manager.dispatch({ type: 'newSession' });

        expect(manager.getSnapshot().state.messages).toBeDefined();
    });

    it('does not serialize messages when the snapshot omits them', async () => {
        const { manager } = makeManager();
        await manager.initialize();
        const fake = fakeOf(manager);

        manager.getSnapshot();
        const callsBefore = fake.serializeStateCalls;
        manager.getSnapshot();

        expect(fake.serializeStateCalls).toBe(callsBefore + 1);
    });

    it('getState is read-only: it never consumes the dirty flag', async () => {
        const { manager } = makeManager();
        await manager.initialize();
        const session = manager.activeTab!.session as any;

        manager.getSnapshot();
        session.events.dispatch({ type: 'message_end', message: { role: 'assistant', content: 'x' } });
        manager.getState();

        expect(manager.getSnapshot().state.messages).toBeDefined();
    });

    it('getState never allocates image assetIds', async () => {
        const { manager } = makeManager();
        await manager.initialize();
        fakeOf(manager).messages.push({ role: 'user', content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] });

        const readView = manager.getState(true);
        expect(readView.messages![0].content[0].data).toBe(PNG);

        const { images } = manager.getSnapshot(true);
        expect(images && Object.keys(images)).toHaveLength(1);
    });
});

describe('image asset separation', () => {
    it('replaces image content with assetId refs and ships the data out of band', async () => {
        const { manager } = makeManager();
        await manager.initialize();
        fakeOf(manager).messages.push({
            role: 'user',
            content: [
                { type: 'text', text: 'see' },
                { type: 'image', data: PNG, mimeType: 'image/png' },
            ],
        });

        const { state, images } = manager.getSnapshot(true);

        expect(state.messages![0].content[1]).toEqual({ type: 'image', assetId: expect.any(String) });
        expect(state.messages![0].content[1].data).toBeUndefined();
        const assetId = state.messages![0].content[1].assetId;
        expect(images?.[assetId]).toBe(`data:image/png;base64,${PNG}`);
    });

    it('keeps the same assetId across re-sends and ships no duplicate data', async () => {
        const { manager } = makeManager();
        await manager.initialize();
        fakeOf(manager).messages.push({ role: 'user', content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] });

        const first = manager.getSnapshot(true);
        const assetId = first.state.messages![0].content[0].assetId;
        expect(assetId).toBeDefined();

        (manager.activeTab!.session as any).events.dispatch({
            type: 'message_end',
            message: { role: 'assistant', content: 'ok' },
        });
        const second = manager.getSnapshot(true);

        expect(second.state.messages![0].content[0]).toEqual({ type: 'image', assetId });
        expect(second.images).toBeUndefined();
    });

    it('ships only newly added images', async () => {
        const { manager } = makeManager();
        await manager.initialize();
        const fake = fakeOf(manager);
        fake.messages.push({ role: 'user', content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] });
        manager.getSnapshot(true);

        fake.messages.push({ role: 'user', content: [{ type: 'image', data: JPEG, mimeType: 'image/jpeg' }] });
        (manager.activeTab!.session as any).events.dispatch({
            type: 'message_end',
            message: { role: 'assistant', content: 'x' },
        });

        const { images } = manager.getSnapshot(true);
        expect(Object.values(images ?? {})).toEqual([`data:image/jpeg;base64,${JPEG}`]);
    });
});

describe('lazy initialization', () => {
    it('dispatch auto-initializes when the manager was never initialized', async () => {
        const { manager, hooks, factory } = makeManager();

        await manager.dispatch({ type: 'getState' });

        expect(factory.create).toHaveBeenCalledTimes(1);
        const sync = vi.mocked(hooks.post).mock.calls.find((c) => (c[0] as any).type === 'stateSync');
        expect(sync).toBeDefined();
        expect((sync![0] as any).state.messages).toEqual([]);
    });

    it('concurrent session entry points wait for one initialization', async () => {
        const { manager, factory } = makeManager();

        await Promise.all([
            manager.dispatch({ type: 'getState' }),
            manager.dispatch({ type: 'newSession' }),
            manager.dispatch({ type: 'loadSession', sessionPath: '/s/a.jsonl' }),
            manager.dispatch({ type: 'getState' }),
        ]);

        expect(factory.create).toHaveBeenCalledTimes(1);
        expect(manager.activeTab).toBeDefined();
    });
});
