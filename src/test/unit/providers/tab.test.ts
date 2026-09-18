import { describe, it, expect, vi } from 'vitest';
import { TabManager, type Tab, type TabFactory, type TabManagerHooks } from '../../../providers/tab';
import { EventRouter } from '../../../pi/events';
import { DiffManager } from '../../../providers/diff';
import { CheckpointManager } from '../../../providers/checkpoint';
import { refreshPiConfig } from '../../../pi/config';
import { t } from '../../../shared/i18n';
import type { DropResolveResult, PiConfigSnapshot, SerializedAgentState } from '../../../shared/protocol';

vi.mock('../../../pi/config', () => ({
    ensureConfigDiscovered: vi.fn(async () => CONFIG_SNAPSHOT),
    refreshPiConfig: vi.fn(async () => CONFIG_SNAPSHOT),
}));

const CONFIG_SNAPSHOT: PiConfigSnapshot = {
    status: 'ok',
    agentDir: '/home/u/.pi/agent',
    agentDirExists: true,
    providers: ['deepseek'],
    models: [{ provider: 'deepseek', id: 'deepseek-chat' }],
    skills: [],
    errors: [],
    discoveredAt: 1_000,
};

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
        writeClipboard: vi.fn(async () => {}),
        getCwd: vi.fn(() => '/work'),
        applyPreview: vi.fn(async () => ({
            previewId: 'ap-1',
            targetPath: '/work/a.ts',
            isNew: false,
            diff: '+code',
            addedLines: 1,
            removedLines: 0,
            code: 'code',
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

    it('posts the config snapshot and refreshes it on request', async () => {
        const factory: TabFactory = { create: vi.fn(async () => makeTab()) };
        const hooks = makeHooks();
        const manager = new TabManager(factory, hooks);
        await manager.initialize();

        await manager.postConfigSnapshot();
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'configState', config: CONFIG_SNAPSHOT } as any),
        );

        vi.mocked(hooks.post).mockClear();
        await manager.dispatch({ type: 'refreshConfig' });
        expect(refreshPiConfig).toHaveBeenCalledWith('/work');
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'configState', config: CONFIG_SNAPSHOT } as any),
        );
    });

    it('prompts compaction once per stage as usage crosses the threshold', async () => {
        let percent: number = 82;
        const tab = makeTab({
            getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent }) as any,
        });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(manager.getState().compactionPrompt).toBe(82);

        // Still inside the threshold band: the same prompt persists, no escalation.
        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(manager.getState().compactionPrompt).toBe(82);

        // Crossing 90% escalates to the final prompt.
        percent = 92;
        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(manager.getState().compactionPrompt).toBe(92);
    });

    it('dismisses the compaction banner until the 90% escalation', async () => {
        let percent: number = 85;
        const tab = makeTab({
            getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent }) as any,
        });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(manager.getState().compactionPrompt).toBe(85);

        await manager.dispatch({ type: 'compactionDismiss' });
        expect(manager.getState().compactionPrompt).toBeNull();

        // Dismissal at the threshold stage does not resurrect; 90% does.
        percent = 86;
        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(manager.getState().compactionPrompt).toBeNull();

        percent = 93;
        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(manager.getState().compactionPrompt).toBe(93);
    });

    it('runs the native compact on accept and reports success', async () => {
        let percent = 85;
        const tab = makeTab({
            getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent }) as any,
            compact: vi.fn(async () => {
                percent = 5;
            }),
        });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        vi.mocked(hooks.post).mockClear();

        await manager.dispatch({ type: 'compactionAccept' });
        expect(tab.session.compact).toHaveBeenCalled();
        expect(hooks.post).toHaveBeenCalledWith({ type: 'compactionResult', ok: true });
        expect(manager.getState().compactionPrompt).toBeNull();
    });

    it('reports compaction failure without throwing and keeps the re-prompt stage', async () => {
        let percent = 85;
        const tab = makeTab({
            getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent }) as any,
            compact: vi.fn(async () => {
                throw new Error('boom');
            }),
        });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        vi.mocked(hooks.post).mockClear();

        await expect(manager.dispatch({ type: 'compactionAccept' })).resolves.toBeUndefined();
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'compactionResult', ok: false, message: expect.stringContaining('boom') }),
        );
        expect(manager.getState().compactionPrompt).toBeNull();

        // The failed threshold compact still escalates at 90%.
        percent = 91;
        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(manager.getState().compactionPrompt).toBe(91);
    });

    it('does not re-prompt right after an accepted compact while usage stays high', async () => {
        let percent = 85;
        const tab = makeTab({
            getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent }) as any,
        });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(manager.getState().compactionPrompt).toBe(85);

        // compact() succeeds but usage is recomputed lazily and stays high:
        // the banner must not instantly re-appear after an explicit accept.
        await manager.dispatch({ type: 'compactionAccept' });
        expect(manager.getState().compactionPrompt).toBeNull();

        // Once usage falls under the threshold the stage re-arms, so a later
        // climb prompts fresh.
        percent = 40;
        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        percent = 84;
        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(manager.getState().compactionPrompt).toBe(84);
    });

    it('ignores a second accept while a compact is in flight', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tab = makeTab({
            getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent: 85 }) as any,
            compact: vi.fn(async () => {
                await gate;
            }),
        });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        const first = manager.dispatch({ type: 'compactionAccept' });
        const second = manager.dispatch({ type: 'compactionAccept' });
        release();
        await Promise.all([first, second]);
        expect(tab.session.compact).toHaveBeenCalledTimes(1);
    });

    it('keeps the compaction prompt per tab across switches', async () => {
        let call = 0;
        const factory: TabFactory = {
            create: vi.fn(async () =>
                makeTab(
                    call++ === 0
                        ? { getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent: 88 }) as any }
                        : {},
                ),
            ),
        };
        const manager = new TabManager(factory, makeHooks());
        await manager.initialize();

        const highId = manager.getState().activeTabId!;
        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(manager.getState().compactionPrompt).toBe(88);

        // Creating a tab activates it, so the low-usage tab takes over.
        await manager.dispatch({ type: 'createTab' });
        const lowId = manager.getState().activeTabId!;
        expect(lowId).not.toBe(highId);
        expect(manager.getState().compactionPrompt).toBeNull();

        // The high tab's prompt stays parked per tab and returns on switch.
        await manager.dispatch({ type: 'switchTab', tabId: highId });
        expect(manager.getState().compactionPrompt).toBe(88);

        await manager.dispatch({ type: 'switchTab', tabId: lowId });
        expect(manager.getState().compactionPrompt).toBeNull();
    });

    it('passes prompt images through to the session', async () => {
        const tab = makeTab({ supportsImages: () => true });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
        await manager.dispatch({ type: 'prompt', text: 'look', images: [png] });

        expect(tab.session.prompt).toHaveBeenCalledWith('look', [
            { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
        ]);
    });

    it('rejects prompt images when the model cannot accept them', async () => {
        const tab = makeTab({ supportsImages: () => false });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
        await manager.dispatch({ type: 'prompt', text: 'look', images: [png] });

        expect(tab.session.prompt).not.toHaveBeenCalled();
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error' } as any),
        );
    });

    it('rejects invalid prompt images without starting a turn', async () => {
        const tab = makeTab();
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'prompt', text: 'look', images: ['data:image/png;base64,###'] });

        expect(tab.session.prompt).not.toHaveBeenCalled();
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error' } as any),
        );
    });

    it('sends a text-only prompt without an images option', async () => {
        const tab = makeTab();
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'prompt', text: 'plain' });

        expect(tab.session.prompt).toHaveBeenCalledWith('plain', undefined);
    });

    it('appends attached file contents to the prompt text', async () => {
        const tab = makeTab();
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({
            type: 'prompt',
            text: 'review this',
            attachContents: [{ name: 'a.py', content: 'print(1)' }],
        });

        expect(tab.session.prompt).toHaveBeenCalled();
        const [promptText, images] = (tab.session.prompt as any).mock.calls[0];
        expect(images).toBeUndefined();
        expect(promptText).toContain('review this');
        expect(promptText).toContain('[Attached file: a.py]');
        expect(promptText).toContain('print(1)');
    });

    it('does not start a turn for attachments with no usable text', async () => {
        const tab = makeTab();
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({
            type: 'prompt',
            text: '',
            attachContents: [{ name: 'a.md', content: '   \n  ' }],
        });

        expect(tab.session.prompt).not.toHaveBeenCalled();
    });

    it('still starts a turn for an attachment-only prompt', async () => {
        const tab = makeTab();
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({
            type: 'prompt',
            text: '',
            attachContents: [{ name: 'a.md', content: 'body' }],
        });

        expect(tab.session.prompt).toHaveBeenCalled();
        const [promptText] = (tab.session.prompt as any).mock.calls[0];
        expect(promptText).toContain('[Attached file: a.md]');
        expect(promptText).toContain('body');
    });

    it('sendToPi prompts the active tab when it is not streaming', async () => {
        const tab = makeTab();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await manager.initialize();

        await manager.sendToPi('look at this');

        expect(tab.session.prompt).toHaveBeenCalledWith('look at this', undefined);
        expect(tab.session.followUp).not.toHaveBeenCalled();
    });

    it('sendToPi queues via followUp while the active tab is streaming', async () => {
        const tab = makeTab({ getFollowUpMessages: () => ['look at this'] });
        const manager = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await manager.initialize();

        manager.activeTab!.session.events.dispatch({ type: 'agent_start' } as any);
        await manager.sendToPi('look at this');

        expect(tab.session.prompt).not.toHaveBeenCalled();
        expect(tab.session.followUp).toHaveBeenCalledWith('look at this');
        expect(manager.getState().queuedMessages).toEqual(['look at this']);
    });

    it('sendToPi resumes prompting once streaming settles', async () => {
        const tab = makeTab();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await manager.initialize();

        manager.activeTab!.session.events.dispatch({ type: 'agent_start' } as any);
        manager.activeTab!.session.events.dispatch({ type: 'agent_settled' } as any);
        await manager.sendToPi('look at this');

        expect(tab.session.prompt).toHaveBeenCalledWith('look at this', undefined);
    });

    it('sendToPi routes to the active tab in multi-tab setups', async () => {
        const first = makeTab();
        const second = makeTab();
        const factory: TabFactory = {
            create: vi.fn(async () => first),
        };
        const manager = new TabManager(factory, makeHooks());
        await manager.initialize();
        // Replace the pool with distinct tabs for each create call.
        (factory.create as any).mockImplementation(async () => second);
        await manager.dispatch({ type: 'createTab' });

        await manager.sendToPi('hello');

        expect(second.session.prompt).toHaveBeenCalledWith('hello', undefined);
        expect(first.session.prompt).not.toHaveBeenCalled();
    });

    it('resets the compaction stage on a new session', async () => {
        let percent = 85;
        const tab = makeTab({
            getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent }) as any,
            newSession: vi.fn(async () => {
                percent = 5;
            }),
        });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(manager.getState().compactionPrompt).toBe(85);

        // A fresh session drops the usage, so no prompt is pending.
        await manager.dispatch({ type: 'newSession' });
        expect(manager.getState().compactionPrompt).toBeNull();

        // When the context fills up again the prompt fires like new.
        percent = 85;
        await manager.dispatch({ type: 'setThinkingLevel', level: 'medium' });
        expect(manager.getState().compactionPrompt).toBe(85);
    });

    it('auto-approves remembered tools and posts a memory trace', async () => {
        let handler: ((id: string, tool: string, args: any) => Promise<boolean>) | undefined;
        const tab = makeTab({
            setToolApprovalHandler: (h: any) => { handler = h; },
        });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();
        expect(handler).toBeDefined();

        // First call prompts: a pending card is posted.
        const first = handler!('t1', 'write', {});
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'toolCallPending' } as any),
        );

        // Remember + approve resolves the promise.
        await manager.dispatch({ type: 'rememberToolApproval', toolCallId: 't1', scope: 'session' });
        expect(await first).toBe(true);

        // Second call is auto-approved from memory with a trace, no card.
        vi.mocked(hooks.post).mockClear();
        const second = await handler!('t2', 'write', {});
        expect(second).toBe(true);
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'approvalTrace', toolCallId: 't2', toolName: 'write', scope: 'session' } as any),
        );
        expect(hooks.post).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'toolCallPending' } as any),
        );
    });

    it('never auto-approves dangerous tools from memory', async () => {
        let handler: ((id: string, tool: string, args: any) => Promise<boolean>) | undefined;
        const tab = makeTab({
            setToolApprovalHandler: (h: any) => { handler = h; },
        });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'rememberToolApproval', toolCallId: 'missing', scope: 'global' });

        const pending = handler!('t1', 'bash', {});
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'toolCallPending' } as any),
        );
        await manager.dispatch({ type: 'rememberToolApproval', toolCallId: 't1', scope: 'global' });
        expect(await pending).toBe(true);

        // Even though remember was requested, bash must prompt again.
        vi.mocked(hooks.post).mockClear();
        handler!('t2', 'bash', {});
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'toolCallPending' } as any),
        );
    });

    it('answers mention queries through the search hooks without a state change', async () => {
        const hooks = makeHooks({
            searchFiles: vi.fn(async () => ['src/a.ts']),
            searchSymbols: vi.fn(async () => [{ name: 'Tab', kind: 'Class', path: 'src/tab.ts', line: 8 }]),
        });
        const manager = new TabManager({ create: vi.fn(async () => makeTab()) }, hooks);
        await manager.initialize();

        const listener = vi.fn();
        manager.onStateChange(listener);
        await manager.dispatch({ type: 'mentionQuery', query: 'tab', requestId: 7 });

        expect(hooks.post).toHaveBeenCalledWith({
            type: 'mentionResults',
            requestId: 7,
            files: ['src/a.ts'],
            symbols: [{ name: 'Tab', kind: 'Class', path: 'src/tab.ts', line: 8 }],
        });
        expect(listener).not.toHaveBeenCalled();
    });

    it('answers dropFiles through the resolution hook without a state change', async () => {
        const hooks = makeHooks({
            resolveDroppedFiles: vi.fn(async (): Promise<DropResolveResult[]> => [
                { status: 'file', path: 'src/a.ts' },
                { status: 'image' },
                { status: 'invalid' },
            ]),
        });
        const manager = new TabManager({ create: vi.fn(async () => makeTab()) }, hooks);
        await manager.initialize();

        const listener = vi.fn();
        manager.onStateChange(listener);
        await manager.dispatch({
            type: 'dropFiles',
            uris: ['file:///w/src/a.ts', 'file:///w/img.png', 'file:///w/outside.txt'],
            requestId: 9,
        });

        expect(hooks.resolveDroppedFiles).toHaveBeenCalledWith([
            'file:///w/src/a.ts', 'file:///w/img.png', 'file:///w/outside.txt',
        ]);
        expect(hooks.post).toHaveBeenCalledWith({
            type: 'dropResolved',
            requestId: 9,
            results: [
                { status: 'file', path: 'src/a.ts' },
                { status: 'image' },
                { status: 'invalid' },
            ],
        });
        expect(listener).not.toHaveBeenCalled();
    });

    it('expands a valid mention with the file content on prompt', async () => {
        const tab = makeTab();
        const hooks = makeHooks({
            resolveMentionPath: vi.fn(async (p: string) => (p === 'src/a.ts' ? '/abs/a.ts' : null)),
            readTextFile: vi.fn(async () => 'const a = 1;'),
        });
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'prompt', text: 'explain @src/a.ts please', mentions: ['src/a.ts'] });

        const sent = vi.mocked(tab.session.prompt).mock.calls[0][0];
        expect(sent).toContain('explain @src/a.ts please');
        expect(sent).toContain('@src/a.ts:\n```ts\nconst a = 1;\n```');
    });

    it('strips invalid mentions, reports them, and still prompts', async () => {
        const tab = makeTab();
        const hooks = makeHooks({
            resolveMentionPath: vi.fn(async () => null),
        });
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'prompt', text: 'look at @gone.ts now', mentions: ['gone.ts'] });

        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error' } as any),
        );
        expect(tab.session.prompt).toHaveBeenCalledWith('look at now', undefined);
    });

    it('skips the turn when every mention is invalid and the remaining text is empty', async () => {
        const tab = makeTab();
        const hooks = makeHooks({
            resolveMentionPath: vi.fn(async () => null),
        });
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        await manager.dispatch({ type: 'prompt', text: '@gone.ts', mentions: ['gone.ts'] });

        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error' } as any),
        );
        expect(tab.session.prompt).not.toHaveBeenCalled();
    });

    it('ignores mentions that no longer appear in the message text', async () => {
        const tab = makeTab();
        const hooks = makeHooks({
            resolveMentionPath: vi.fn(async () => '/abs/a.ts'),
            readTextFile: vi.fn(async () => 'A'),
        });
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        // The user deleted the @token from the draft before sending.
        await manager.dispatch({ type: 'prompt', text: 'plain question', mentions: ['src/a.ts'] });

        expect(hooks.resolveMentionPath).not.toHaveBeenCalled();
        expect(tab.session.prompt).toHaveBeenCalledWith('plain question', undefined);
    });

    it('does not expand a file token that only survives as a symbol-token prefix', async () => {
        const tab = makeTab();
        const hooks = makeHooks({
            resolveMentionPath: vi.fn(async () => '/abs/a.ts'),
            readTextFile: vi.fn(async () => 'l1\nl2'),
        });
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        // '@src/a.ts' is not in the draft as a whole token — only
        // '@src/a.ts:42' is. The file ref must not be expanded too.
        await manager.dispatch({
            type: 'prompt',
            text: 'explain @src/a.ts:42',
            mentions: ['src/a.ts', 'src/a.ts:42'],
        });

        expect(hooks.resolveMentionPath).toHaveBeenCalledTimes(1);
        const sent = vi.mocked(tab.session.prompt).mock.calls[0][0];
        expect(sent).not.toContain('@src/a.ts:\n');
        expect(sent).toContain('@src/a.ts:42:');
    });

    it('re-checks streaming after mention expansion to avoid a double turn', async () => {
        const tab = makeTab();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const hooks = makeHooks({
            resolveMentionPath: vi.fn(async (p: string) => {
                await gate;
                return p === 'src/a.ts' ? '/abs/a.ts' : null;
            }),
            readTextFile: vi.fn(async () => 'A'),
        });
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();

        const dispatching = manager.dispatch({
            type: 'prompt', text: 'explain @src/a.ts please', mentions: ['src/a.ts'],
        });
        // While the host is expanding mentions, the agent starts streaming
        // (e.g. a queued follow-up drained first).
        manager.activeTab!.session.events.dispatch({ type: 'agent_start' } as any);
        release();
        await expect(dispatching).rejects.toThrow(/still processing/i);
        expect(tab.session.prompt).not.toHaveBeenCalled();
    });
});

describe('TabManager built-in slash command dispatch', () => {
    async function setup(overrides: Partial<Tab['session']> = {}, hookOverrides: Partial<TabManagerHooks> = {}) {
        const tab = makeTab(overrides);
        const hooks = makeHooks(hookOverrides);
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();
        return { tab, hooks, manager };
    }

    it('runs SDK compaction for /compact instead of prompting', async () => {
        const { tab, hooks, manager } = await setup();
        await manager.dispatch({ type: 'prompt', text: '/compact' });
        expect(tab.session.compact).toHaveBeenCalledWith(undefined);
        expect(tab.session.prompt).not.toHaveBeenCalled();
        const result = vi.mocked(hooks.post).mock.calls.find(
            (call) => (call[0] as any).type === 'compactionResult',
        );
        expect((result?.[0] as any)?.ok).toBe(true);
    });

    it('passes /compact arguments as custom instructions', async () => {
        const { tab, manager } = await setup();
        await manager.dispatch({ type: 'prompt', text: '/compact   keep the plan and todos' });
        expect(tab.session.compact).toHaveBeenCalledWith('keep the plan and todos');
        expect(tab.session.prompt).not.toHaveBeenCalled();
    });

    it('rejects /compact while streaming without compacting or prompting', async () => {
        const { tab, hooks, manager } = await setup();
        (manager.activeTab as any).isStreaming = true;
        await manager.dispatch({ type: 'prompt', text: '/compact' });
        expect(tab.session.compact).not.toHaveBeenCalled();
        expect(tab.session.prompt).not.toHaveBeenCalled();
        expect(hooks.showMessage).toHaveBeenCalled();
    });

    it('starts a new session for /new', async () => {
        const { tab, manager } = await setup();
        await manager.dispatch({ type: 'prompt', text: '/new' });
        expect(tab.session.newSession).toHaveBeenCalled();
        expect(tab.session.prompt).not.toHaveBeenCalled();
    });

    it('opens the model picker for /model', async () => {
        const { tab, manager } = await setup();
        await manager.dispatch({ type: 'prompt', text: '/model' });
        expect(tab.session.showModelPicker).toHaveBeenCalled();
        expect(tab.session.prompt).not.toHaveBeenCalled();
    });

    it('renames the session for /name <args> and reports usage without args', async () => {
        const { tab, manager } = await setup({
            setSessionName: vi.fn(),
            getCurrentSessionPath: vi.fn(() => undefined),
            getSessions: vi.fn(async () => []),
        });
        await manager.dispatch({ type: 'prompt', text: '/name My Session' });
        expect(tab.session.setSessionName).toHaveBeenCalledWith('My Session');
        await manager.dispatch({ type: 'prompt', text: '/name' });
        expect(tab.session.setSessionName).toHaveBeenCalledTimes(1);
    });

    it('posts the sessions list for /resume', async () => {
        const { hooks, manager } = await setup({
            getSessions: vi.fn(async () => []),
        });
        await manager.dispatch({ type: 'prompt', text: '/resume' });
        const sent = vi.mocked(hooks.post).mock.calls.find(
            (call) => (call[0] as any).type === 'sessions',
        );
        expect(sent).toBeDefined();
    });

    it('opens settings for /settings and /login', async () => {
        const { hooks, manager } = await setup();
        await manager.dispatch({ type: 'prompt', text: '/settings' });
        expect(hooks.openSettings).toHaveBeenCalledTimes(1);
        await manager.dispatch({ type: 'prompt', text: '/login' });
        expect(hooks.openSettings).toHaveBeenCalledTimes(2);
        expect(hooks.showMessage).toHaveBeenCalled();
    });

    it('copies the last assistant reply for /copy', async () => {
        const { hooks, manager } = await setup({
            getMessages: vi.fn(() => [
                { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
            ]),
        });
        await manager.dispatch({ type: 'prompt', text: '/copy' });
        expect(hooks.writeClipboard).toHaveBeenCalledWith('the answer');
        expect(hooks.showMessage).toHaveBeenCalled();
    });

    it('reports an empty clipboard source for /copy without replies', async () => {
        const { hooks, manager } = await setup();
        await manager.dispatch({ type: 'prompt', text: '/copy' });
        expect(hooks.writeClipboard).not.toHaveBeenCalled();
        expect(hooks.showMessage).toHaveBeenCalled();
    });

    it('reports unsupported builtins instead of prompting', async () => {
        const { tab, hooks, manager } = await setup();
        await manager.dispatch({ type: 'prompt', text: '/tree' });
        expect(tab.session.prompt).not.toHaveBeenCalled();
        expect(hooks.showMessage).toHaveBeenCalledWith(
            expect.stringContaining('/tree'),
        );
    });

    it('falls through to the normal prompt for unknown slash commands', async () => {
        const { tab, manager } = await setup();
        await manager.dispatch({ type: 'prompt', text: '/nope' });
        expect(tab.session.prompt).toHaveBeenCalled();
    });

    it('executes a queued builtin immediately instead of queueing it as text', async () => {
        const { tab, manager } = await setup();
        (manager.activeTab as any).isStreaming = true;
        await manager.dispatch({ type: 'queueMessage', text: '/model' });
        expect(tab.session.showModelPicker).toHaveBeenCalled();
        expect(tab.session.followUp).not.toHaveBeenCalled();
    });

    it('still queues plain text while streaming', async () => {
        const { tab, manager } = await setup();
        (manager.activeTab as any).isStreaming = true;
        await manager.dispatch({ type: 'queueMessage', text: 'hello' });
        expect(tab.session.followUp).toHaveBeenCalledWith('hello');
    });

    it('intercepts a builtin sent through the followUp channel', async () => {
        const { tab, manager } = await setup();
        await manager.dispatch({ type: 'followUp', text: '/model' });
        expect(tab.session.showModelPicker).toHaveBeenCalled();
        expect(tab.session.followUp).not.toHaveBeenCalled();
    });

    it('rejects /compact and /new queued while streaming', async () => {
        const { tab, hooks, manager } = await setup();
        (manager.activeTab as any).isStreaming = true;
        await manager.dispatch({ type: 'queueMessage', text: '/compact' });
        await manager.dispatch({ type: 'queueMessage', text: '/new' });
        expect(tab.session.compact).not.toHaveBeenCalled();
        expect(tab.session.newSession).not.toHaveBeenCalled();
        expect(tab.session.followUp).not.toHaveBeenCalled();
        expect(hooks.showMessage).toHaveBeenCalledTimes(2);
    });

    it('rejects /compact on a read-only locked tab', async () => {
        const { tab, hooks, manager } = await setup();
        (manager.activeTab as any).lock = { occupancy: 'read-only' };
        await manager.dispatch({ type: 'prompt', text: '/compact' });
        expect(tab.session.compact).not.toHaveBeenCalled();
        expect(hooks.showMessage).toHaveBeenCalled();
    });

    it('rejects /compact while another compaction is in flight', async () => {
        const { tab, hooks, manager } = await setup();
        (manager.activeTab as any).compactionInFlight = true;
        await manager.dispatch({ type: 'prompt', text: '/compact' });
        expect(tab.session.compact).not.toHaveBeenCalled();
        expect(hooks.showMessage).toHaveBeenCalled();
    });

    it('rejects /compact via steer but executes /model', async () => {
        const { tab, manager } = await setup({ steer: vi.fn(async () => {}) });
        (manager.activeTab as any).isStreaming = true;
        await manager.dispatch({ type: 'steer', text: '/compact' });
        expect(tab.session.compact).not.toHaveBeenCalled();
        expect(tab.session.steer).not.toHaveBeenCalled();
        await manager.dispatch({ type: 'steer', text: '/model' });
        expect(tab.session.showModelPicker).toHaveBeenCalled();
        expect(tab.session.steer).not.toHaveBeenCalled();
    });

    it('refuses editing a queue item into a builtin command', async () => {
        const { tab, hooks, manager } = await setup();
        (manager.activeTab as any).queuedMessages = ['hello'];
        await manager.dispatch({ type: 'editQueuedMessage', index: 0, text: '/new' });
        expect(tab.session.replaceFollowUpMessages).not.toHaveBeenCalled();
        expect(hooks.showMessage).toHaveBeenCalled();
    });

    it('applies an explicit thinking level with an argument', async () => {
        const { tab, manager } = await setup({
            setThinkingLevel: vi.fn(),
            getAvailableThinkingLevels: vi.fn(() => ['off', 'medium', 'high']),
            cycleThinkingLevel: vi.fn(() => 'off'),
        });
        await manager.dispatch({ type: 'prompt', text: '/thinking high' });
        expect(tab.session.setThinkingLevel).toHaveBeenCalledWith('high');
        expect(tab.session.cycleThinkingLevel).not.toHaveBeenCalled();
    });

    it('renames via /name without opening the sessions panel', async () => {
        const { hooks, manager } = await setup({
            setSessionName: vi.fn(),
            getCurrentSessionPath: vi.fn(() => undefined),
            getSessions: vi.fn(async () => []),
        });
        await manager.dispatch({ type: 'prompt', text: '/name Renamed' });
        const sent = vi.mocked(hooks.post).mock.calls.find(
            (call) => (call[0] as any).type === 'sessions',
        );
        expect(sent).toBeUndefined();
    });

    it('reports nothing-to-compact distinctly when the session is too small', async () => {
        const { hooks, manager } = await setup({
            compact: vi.fn(async () => {
                throw new Error('Nothing to compact (session too small)');
            }),
        });
        await manager.dispatch({ type: 'prompt', text: '/compact' });
        const result = vi.mocked(hooks.post).mock.calls.find(
            (call) => (call[0] as any).type === 'compactionResult',
        );
        expect((result?.[0] as any)?.ok).toBe(false);
        expect((result?.[0] as any)?.message).toBe(t('compact.nothingToCompact'));
    });

    it('includes the underlying detail for real compaction failures', async () => {
        const { hooks, manager } = await setup({
            compact: vi.fn(async () => {
                throw new Error('provider 500: boom');
            }),
        });
        await manager.dispatch({ type: 'prompt', text: '/compact' });
        const result = vi.mocked(hooks.post).mock.calls.find(
            (call) => (call[0] as any).type === 'compactionResult',
        );
        expect((result?.[0] as any)?.ok).toBe(false);
        expect(((result?.[0] as any)?.message as string)).toContain('boom');
    });
});
