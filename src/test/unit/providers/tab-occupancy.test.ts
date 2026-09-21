import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';
import { TabManager, type Tab, type TabFactory, type TabManagerAdapters, type TransportAdapter, type WorkspaceAdapter, type UIAdapter, type AgentCapabilities } from '../../../providers/tab';
import { EventRouter } from '../../../pi/events';
import { DiffManager } from '../../../providers/diff';
import { CheckpointManager } from '../../../providers/checkpoint';
import type { PiConfigSnapshot } from '../../../shared/protocol';
import type { SessionLockDeps } from '../../../pi/session-lock';

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

/** In-memory lock fs double, mirroring the session-lock unit tests. */
function makeLockDeps(overrides: Partial<SessionLockDeps> = {}): SessionLockDeps & {
    files: Map<string, string>;
} {
    const files = new Map<string, string>();
    let tokenSeq = 0;
    const deps: any = {
        files,
        lockDir: '/locks',
        isProcessAlive: (pid: number) => pid === process.pid || pid === 2000,
        now: () => 100_000,
        hash: (s: string) => `h(${s})`,
        newToken: () => `token-${++tokenSeq}`,
        readFile(p: string) { return files.get(p); },
        writeFile(p: string, c: string, opts?: { exclusive?: boolean }) {
            if (opts?.exclusive && files.has(p)) {
                const err: any = new Error('EEXIST');
                err.code = 'EEXIST';
                throw err;
            }
            files.set(p, c);
        },
        deleteFile(p: string) { files.delete(p); },
    };
    return Object.assign(deps, overrides);
}

function lockPath(deps: any, sessionFile: string): string {
    return path.join(deps.lockDir, `${deps.hash(sessionFile)}.lock`);
}

function foreignLock(): string {
    return JSON.stringify({ pid: 2000, token: 'other-token', acquiredAt: 90_000, heartbeatAt: 99_999 });
}

const managers: TabManager[] = [];

afterEach(() => {
    for (const manager of managers.splice(0)) {
        void manager.dispose();
    }
});

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

function makeAdapters(overrides: { transport?: Partial<TransportAdapter>; workspace?: Partial<WorkspaceAdapter>; ui?: Partial<UIAdapter>; agent?: Partial<AgentCapabilities> } = {}): TabManagerAdapters {
    return {
        transport: {
            post: vi.fn(),
            setContext: vi.fn(),
            ...overrides.transport,
        },
        workspace: {
            openFile: vi.fn(),
            getCwd: vi.fn(() => '/work'),
            searchFiles: vi.fn(async () => []),
            searchSymbols: vi.fn(async () => []),
            resolveMentionPath: vi.fn(async () => null),
            readTextFile: vi.fn(async () => null),
            resolveDroppedFiles: vi.fn(async () => []),
            ...overrides.workspace,
        },
        ui: {
            showMessage: vi.fn(),
            confirmDialog: vi.fn(async () => false),
            openSettings: vi.fn(),
            writeClipboard: vi.fn(async () => {}),
            ...overrides.ui,
        },
        agent: {
            applyPreview: vi.fn(async () => null),
            applyConfirm: vi.fn(async () => ({ ok: true })),
            applyCancel: vi.fn(),
            getCompactionThreshold: vi.fn(() => 80),
            ...overrides.agent,
        },
    };
}

async function makeManager(lockDeps?: SessionLockDeps, sessionOverrides: Partial<Tab['session']> = {}) {
    const factory: TabFactory = { create: vi.fn(async () => makeTab(sessionOverrides)) };
    const adapters = makeAdapters();
    const manager = new TabManager(factory, adapters, undefined, lockDeps);
    managers.push(manager);
    await manager.initialize();
    return { manager, adapters, factory };
}

describe('TabManager single-writer occupancy (AC-OP-03)', () => {
    it('acquires the lock on loadSession and stays writable', async () => {
        const lockDeps = makeLockDeps();
        const { manager } = await makeManager(lockDeps, {
            getCurrentSessionPath: () => '/s/a.jsonl',
        });

        await manager.dispatch({ type: 'loadSession', sessionPath: '/s/a.jsonl' });

        expect(lockDeps.files.get(lockPath(lockDeps, '/s/a.jsonl'))).toContain('"pid":' + process.pid);
        expect(manager.getState().occupancy).toBeUndefined();
    });

    it('flags the session read-only when another window holds the lock', async () => {
        const lockDeps = makeLockDeps();
        lockDeps.files.set(lockPath(lockDeps, '/s/a.jsonl'), foreignLock());
        const { manager } = await makeManager(lockDeps);

        await manager.dispatch({ type: 'loadSession', sessionPath: '/s/a.jsonl' });

        expect(manager.getState().occupancy).toBe('occupiedByOther');
    });

    it('rejects prompt while read-only and tells the user why', async () => {
        const lockDeps = makeLockDeps();
        lockDeps.files.set(lockPath(lockDeps, '/s/a.jsonl'), foreignLock());
        const { manager, adapters } = await makeManager(lockDeps);
        await manager.dispatch({ type: 'loadSession', sessionPath: '/s/a.jsonl' });
        const session = manager.activeTab!.session as any;

        await manager.dispatch({ type: 'prompt', text: 'hello' });

        expect(session.prompt).not.toHaveBeenCalled();
        expect(adapters.ui.showMessage).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });

    it('restores write access after takeover', async () => {
        const lockDeps = makeLockDeps();
        lockDeps.files.set(lockPath(lockDeps, '/s/a.jsonl'), foreignLock());
        const { manager } = await makeManager(lockDeps);
        await manager.dispatch({ type: 'loadSession', sessionPath: '/s/a.jsonl' });

        await manager.dispatch({ type: 'sessionTakeover' });

        expect(manager.getState().occupancy).toBeUndefined();
        expect(lockDeps.files.get(lockPath(lockDeps, '/s/a.jsonl'))).toContain('"pid":' + process.pid);
    });

    it('accepts prompt again once the occupancy is cleared', async () => {
        const lockDeps = makeLockDeps();
        lockDeps.files.set(lockPath(lockDeps, '/s/a.jsonl'), foreignLock());
        const { manager } = await makeManager(lockDeps);
        await manager.dispatch({ type: 'loadSession', sessionPath: '/s/a.jsonl' });
        await manager.dispatch({ type: 'sessionTakeover' });

        await manager.dispatch({ type: 'prompt', text: 'hello' });

        expect((manager.activeTab!.session as any).prompt).toHaveBeenCalledWith('hello', undefined);
    });

    it('releases the previous lock when switching sessions', async () => {
        const lockDeps = makeLockDeps();
        const { manager } = await makeManager(lockDeps);

        await manager.dispatch({ type: 'loadSession', sessionPath: '/s/a.jsonl' });
        await manager.dispatch({ type: 'loadSession', sessionPath: '/s/b.jsonl' });

        expect(lockDeps.files.has(lockPath(lockDeps, '/s/a.jsonl'))).toBe(false);
        expect(lockDeps.files.has(lockPath(lockDeps, '/s/b.jsonl'))).toBe(true);
    });

    it('acquires the lock for a new session after its first persisted entry', async () => {
        const lockDeps = makeLockDeps();
        const { manager } = await makeManager(lockDeps, {
            getCurrentSessionPath: () => '/s/new.jsonl',
        });

        const session = manager.activeTab!.session as any;
        session.events.dispatch({ type: 'entry_appended', entry: { id: 'e1' } });
        await vi.waitFor(() => {
            expect(lockDeps.files.has(lockPath(lockDeps, '/s/new.jsonl'))).toBe(true);
        });

        expect(manager.getState().occupancy).toBeUndefined();
    });

    it('flips to lostLock on heartbeat when another window took the lock over', async () => {
        const lockDeps = makeLockDeps();
        const { manager } = await makeManager(lockDeps);
        await manager.dispatch({ type: 'loadSession', sessionPath: '/s/a.jsonl' });

        lockDeps.files.set(lockPath(lockDeps, '/s/a.jsonl'), foreignLock());
        await (manager as any)._heartbeatAll();

        expect(manager.getState().occupancy).toBe('lostLock');
    });

    it('offers recovery once the occupier releases the lock', async () => {
        const lockDeps = makeLockDeps();
        lockDeps.files.set(lockPath(lockDeps, '/s/a.jsonl'), foreignLock());
        const { manager } = await makeManager(lockDeps);
        await manager.dispatch({ type: 'loadSession', sessionPath: '/s/a.jsonl' });

        lockDeps.files.delete(lockPath(lockDeps, '/s/a.jsonl'));
        await (manager as any)._heartbeatAll();

        expect(manager.getState().occupancy).toBe('releasedByOther');
    });
});
