import { describe, it, expect, vi } from 'vitest';
import { TabManager, type Tab, type TabFactory, type TabManagerHooks } from '../../../providers/tab';
import { EventRouter } from '../../../pi/events';
import { DiffManager } from '../../../providers/diff';
import { CheckpointManager } from '../../../providers/checkpoint';
import { refreshPiConfig } from '../../../pi/config';
import type { DropResolveResult, PiConfigSnapshot, SerializedAgentState, TerminalQuoteResult } from '../../../shared/protocol';

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
        quoteTerminal: vi.fn(async (): Promise<TerminalQuoteResult> => ({ ok: false, reason: 'noTerminal' })),
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
        expect(hooks.post).toHaveBeenCalledWith({ type: 'compactionResult', ok: false });
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

    it('answers terminalQuote through the capture hook without a state change', async () => {
        const hooks = makeHooks({
            quoteTerminal: vi.fn(async (): Promise<TerminalQuoteResult> => ({
                ok: true,
                entry: { command: 'npm test', output: 'all green\n', terminalName: 'bash' },
            })),
        });
        const manager = new TabManager({ create: vi.fn(async () => makeTab()) }, hooks);
        await manager.initialize();

        const listener = vi.fn();
        manager.onStateChange(listener);
        await manager.dispatch({ type: 'terminalQuote', requestId: 12 });

        expect(hooks.quoteTerminal).toHaveBeenCalledWith();
        expect(hooks.post).toHaveBeenCalledWith({
            type: 'terminalQuoted',
            requestId: 12,
            result: {
                ok: true,
                entry: { command: 'npm test', output: 'all green\n', terminalName: 'bash' },
            },
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

describe('TabManager plan mode (C8/C9)', () => {
    function makePlanTab(extra: Record<string, any> = {}) {
        let messages: any[] = [];
        const tab = makeTab({
            getActiveToolNames: vi.fn(() => ['read', 'edit', 'bash', 'write']),
            setActiveToolsByName: vi.fn(),
            getMessages: vi.fn(() => messages),
            ...extra,
        });
        const setPlanMessages = (msgs: any[]) => { messages = msgs; };
        return { tab, setPlanMessages };
    }

    const PLAN_TEXT = '```plan\n1. Step A\n2. Step B\n```';
    const PLAN_MESSAGES = [
        { role: 'user', content: [{ type: 'text', text: 'build it' }] },
        { role: 'assistant', content: [{ type: 'text', text: PLAN_TEXT }] },
    ];

    async function planToAwaitingApproval(manager: TabManager, tab: any): Promise<void> {
        await manager.dispatch({ type: 'planStart' });
        await manager.dispatch({ type: 'prompt', text: 'build it' });
        tab.session.events.dispatch({ type: 'agent_settled' } as any);
    }

    it('restricts the toolset to read-only on planStart and restores it on planCancel', async () => {
        const { tab } = makePlanTab();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await manager.initialize();

        await manager.dispatch({ type: 'planStart' });
        expect(tab.session.setActiveToolsByName).toHaveBeenLastCalledWith(['read']);
        expect(manager.getState().plan?.phase).toBe('planning');

        await manager.dispatch({ type: 'planCancel' });
        expect(tab.session.setActiveToolsByName).toHaveBeenLastCalledWith(['read', 'edit', 'bash', 'write']);
        expect(manager.getState().plan?.phase).toBe('off');
    });

    it('wraps a prompt with the planning instructions during planning', async () => {
        const { tab } = makePlanTab();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await manager.initialize();

        await manager.dispatch({ type: 'planStart' });
        await manager.dispatch({ type: 'prompt', text: 'build it' });

        const sent = vi.mocked(tab.session.prompt).mock.calls[0][0] as string;
        expect(sent).toContain('build it');
        expect(sent).toContain('Plan mode');
        expect(sent).toContain('`plan`');
    });

    it('moves to awaitingApproval and restores tools when the plan block arrives', async () => {
        const { tab, setPlanMessages } = makePlanTab();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await manager.initialize();
        setPlanMessages(PLAN_MESSAGES);

        await planToAwaitingApproval(manager, tab);

        expect(tab.session.setActiveToolsByName).toHaveBeenLastCalledWith(['read', 'edit', 'bash', 'write']);
        const plan = manager.getState().plan;
        expect(plan?.phase).toBe('awaitingApproval');
        expect(plan?.steps.map((s) => s.title)).toEqual(['Step A', 'Step B']);
        expect(plan?.steps.every((s) => s.status === 'pending')).toBe(true);
    });

    it('reports a missing plan block and stays planning', async () => {
        const hooks = makeHooks();
        const { tab, setPlanMessages } = makePlanTab();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();
        setPlanMessages([{ role: 'assistant', content: [{ type: 'text', text: 'no plan here' }] }]);

        await planToAwaitingApproval(manager, tab);

        expect(manager.getState().plan?.phase).toBe('planning');
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error' } as any),
        );
    });

    it('keeps planning through an abort without reporting a missing plan', async () => {
        const hooks = makeHooks();
        const { tab, setPlanMessages } = makePlanTab();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();
        setPlanMessages([{ role: 'assistant', content: [{ type: 'text', text: 'no plan here' }] }]);

        await manager.dispatch({ type: 'planStart' });
        await manager.dispatch({ type: 'prompt', text: 'build it' });
        await manager.dispatch({ type: 'abort' });
        tab.session.events.dispatch({ type: 'agent_settled' } as any);

        expect(manager.getState().plan?.phase).toBe('planning');
        expect(hooks.post).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error' } as any),
        );
    });

    it('executes steps sequentially and finishes the plan', async () => {
        const { tab, setPlanMessages } = makePlanTab();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await manager.initialize();
        setPlanMessages(PLAN_MESSAGES);

        await planToAwaitingApproval(manager, tab);
        await manager.dispatch({ type: 'planApprove' });
        await vi.waitFor(() => {
            expect(manager.getState().plan?.phase).toBe('done');
        });

        const prompts = vi.mocked(tab.session.prompt).mock.calls.map((c) => c[0] as string);
        expect(prompts).toHaveLength(3); // planning turn + 2 steps
        expect(prompts[1]).toContain('Plan step 1/2');
        expect(prompts[1]).toContain('Step A');
        expect(prompts[2]).toContain('Plan step 2/2');
        expect(manager.getState().plan?.steps.every((s) => s.status === 'done')).toBe(true);
    });

    it('applies local step edits and replans on request', async () => {
        const { tab, setPlanMessages } = makePlanTab();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await manager.initialize();
        setPlanMessages(PLAN_MESSAGES);

        await planToAwaitingApproval(manager, tab);
        await manager.dispatch({ type: 'planSetSteps', titles: ['Step B', 'Step A', 'Step C'] });
        expect(manager.getState().plan?.steps.map((s) => s.title)).toEqual(['Step B', 'Step A', 'Step C']);

        await manager.dispatch({ type: 'planReplan' });
        expect(manager.getState().plan?.phase).toBe('planning');
        expect(tab.session.setActiveToolsByName).toHaveBeenLastCalledWith(['read']);
    });

    it('auto-approves plan-credential tools during execution and pauses on dangerous ones', async () => {
        let handler: ((id: string, tool: string, args: any) => Promise<boolean>) | undefined;
        let hang = false;
        const { tab, setPlanMessages } = makePlanTab({
            setToolApprovalHandler: (h: any) => { handler = h; },
            prompt: vi.fn(() => (hang ? new Promise<void>(() => {}) : Promise.resolve())),
        });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();
        setPlanMessages(PLAN_MESSAGES);

        await planToAwaitingApproval(manager, tab);
        hang = true;
        await manager.dispatch({ type: 'planApprove' });
        await vi.waitFor(() => {
            expect(manager.getState().plan?.currentStep).toBe(0);
        });

        // Non-dangerous plan credential: auto-approved with a Plan trace.
        vi.mocked(hooks.post).mockClear();
        expect(await handler!('c1', 'edit', {})).toBe(true);
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'approvalTrace', toolName: 'edit', source: 'plan' } as any),
        );
        expect(hooks.post).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'toolCallPending' } as any),
        );

        // Dangerous tool: card goes up and the step pauses.
        const dangerous = handler!('c2', 'bash', {});
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'toolCallPending' } as any),
        );
        expect(manager.getState().plan?.phase).toBe('paused');
        expect(manager.getState().plan?.pausedReason).toBe('dangerousTool');

        // Approving the card resumes the paused step.
        await manager.dispatch({ type: 'approveToolCall', toolCallId: 'c2' });
        expect(await dangerous).toBe(true);
        expect(manager.getState().plan?.phase).toBe('executing');
    });

    it('interrupts on abort: done steps kept, the rest cancelled', async () => {
        let hang = false;
        const { tab, setPlanMessages } = makePlanTab({
            prompt: vi.fn(() => (hang ? new Promise<void>(() => {}) : Promise.resolve())),
        });
        const manager = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await manager.initialize();
        setPlanMessages(PLAN_MESSAGES);

        await planToAwaitingApproval(manager, tab);
        hang = true;
        await manager.dispatch({ type: 'planApprove' });
        await vi.waitFor(() => {
            expect(manager.getState().plan?.steps[0]?.status).toBe('running');
        });

        await manager.dispatch({ type: 'abort' });
        expect(tab.session.abort).toHaveBeenCalled();
        const plan = manager.getState().plan;
        expect(plan?.phase).toBe('interrupted');
        expect(plan?.steps[0]?.status).toBe('cancelled');
        expect(plan?.steps[1]?.status).toBe('cancelled');
    });

    it('pauses on a failed step, resumes it, and abandon marks the plan interrupted', async () => {
        // Prompt calls: 1=planning turn, 2=step 0 (fails), 3=step 0 retry (ok),
        // 4=step 1 (fails again).
        let calls = 0;
        const failCalls = new Set([2, 4]);
        const { tab, setPlanMessages } = makePlanTab({
            prompt: vi.fn(() =>
                failCalls.has(++calls) ? Promise.reject(new Error('boom')) : Promise.resolve()),
        });
        const manager = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await manager.initialize();
        setPlanMessages(PLAN_MESSAGES);

        await planToAwaitingApproval(manager, tab);
        await manager.dispatch({ type: 'planApprove' });
        await vi.waitFor(() => {
            expect(manager.getState().plan?.phase).toBe('paused');
        });
        expect(manager.getState().plan?.pausedReason).toBe('boom');
        expect(manager.getState().plan?.steps[0]?.status).toBe('failed');

        await manager.dispatch({ type: 'planResume' });
        await vi.waitFor(() => {
            expect(manager.getState().plan?.steps[0]?.status).toBe('done');
        });
        await vi.waitFor(() => {
            expect(manager.getState().plan?.phase).toBe('paused');
        });
        expect(manager.getState().plan?.steps[1]?.status).toBe('failed');

        await manager.dispatch({ type: 'planAbandon' });
        expect(manager.getState().plan?.phase).toBe('interrupted');
        expect(manager.getState().plan?.steps[0]?.status).toBe('done');
    });

    it('restores tools when closing a finished plan', async () => {
        const { tab, setPlanMessages } = makePlanTab();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await manager.initialize();
        setPlanMessages(PLAN_MESSAGES);

        await planToAwaitingApproval(manager, tab);
        await manager.dispatch({ type: 'planApprove' });
        await vi.waitFor(() => {
            expect(manager.getState().plan?.phase).toBe('done');
        });

        await manager.dispatch({ type: 'planClose' });
        expect(tab.session.setActiveToolsByName).toHaveBeenLastCalledWith(['read', 'edit', 'bash', 'write']);
        expect(manager.getState().plan?.phase).toBe('off');
    });

    it('resets the plan on newSession with a monotonic runId', async () => {
        const { tab } = makePlanTab();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, makeHooks());
        await manager.initialize();

        await manager.dispatch({ type: 'planStart' });
        const runtimeBefore = (manager.activeTab as any).plan;
        expect(runtimeBefore.runId).toBe(0);

        await manager.dispatch({ type: 'newSession' });
        const runtimeAfter = (manager.activeTab as any).plan;
        expect(runtimeAfter).not.toBe(runtimeBefore);
        expect(runtimeAfter.runId).toBe(1);
        expect(manager.getState().plan?.phase).toBe('off');
        expect(tab.session.setActiveToolsByName).toHaveBeenLastCalledWith(['read', 'edit', 'bash', 'write']);
    });

    it('resolves dangling approval cards when aborting an executing plan', async () => {
        let handler: ((id: string, tool: string, args: any) => Promise<boolean>) | undefined;
        let hang = false;
        const { tab, setPlanMessages } = makePlanTab({
            setToolApprovalHandler: (h: any) => { handler = h; },
            prompt: vi.fn(() => (hang ? new Promise<void>(() => {}) : Promise.resolve())),
        });
        const hooks = makeHooks();
        const manager = new TabManager({ create: vi.fn(async () => tab) }, hooks);
        await manager.initialize();
        setPlanMessages(PLAN_MESSAGES);

        await planToAwaitingApproval(manager, tab);
        hang = true;
        await manager.dispatch({ type: 'planApprove' });
        await vi.waitFor(() => {
            expect(manager.getState().plan?.currentStep).toBe(0);
        });

        // A non-credential extension tool during execution gets a normal card.
        vi.mocked(hooks.post).mockClear();
        const pending = handler!('x1', 'apply_patch', {});
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'toolCallPending' } as any),
        );

        await manager.dispatch({ type: 'abort' });
        expect(await pending).toBe(false);
        expect(hooks.post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'toolCallResolved', toolCallId: 'x1' } as any),
        );
        expect(manager.getState().plan?.phase).toBe('interrupted');
    });
});
