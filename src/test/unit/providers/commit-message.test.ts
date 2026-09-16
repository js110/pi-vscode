import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommitMessageManager, type CommitMessageDeps, type CommitGitApi, type CommitGitRepository } from '../../../providers/commit-message';
import { COMMIT_MESSAGE_SYSTEM_PROMPT } from '../../../shared/commit-message';

const h = vi.hoisted(() => ({
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
}));

vi.mock('vscode', () => ({
    workspace: {
        get workspaceFolders() { return h.workspaceFolders; },
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
}));

function makeRepo(root: string, opts?: Partial<CommitGitRepository>): CommitGitRepository {
    return {
        rootUri: { fsPath: root } as any,
        inputBox: { value: '' },
        diff: vi.fn(async (cached?: boolean) =>
            cached ? 'diff --git staged-change' : 'diff --git unstaged-change'),
        ...opts,
    };
}

function makeDeps(overrides: Partial<CommitMessageDeps> = {}): CommitMessageDeps & {
    complete: ReturnType<typeof vi.fn>;
    showMessage: ReturnType<typeof vi.fn>;
    gitApi: CommitGitApi | undefined;
} {
    const deps: any = {
        gitApi: { repositories: [makeRepo('/ws')] } as CommitGitApi,
        complete: vi.fn(async () => ({
            content: [{ type: 'text', text: 'feat: add login flow' }],
        })),
        showMessage: vi.fn(),
        getSessionModel: async () => undefined,
        getConfiguredModel: async () => undefined,
        getFallbackModel: async () => ({ id: 'fallback-model' }),
        getGitApi() { return (this as any).gitApi; },
    };
    return Object.assign(deps, overrides);
}

function repoOf(deps: any): CommitGitRepository {
    return deps.getGitApi().repositories[0];
}

describe('CommitMessageManager', () => {
    beforeEach(() => {
        h.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    });

    it('writes the generated message into the repository input box', async () => {
        const deps = makeDeps();
        const manager = new CommitMessageManager(deps);

        const result = await manager.generateIntoInputBox();

        expect(result).toEqual({ ok: true, message: 'feat: add login flow' });
        expect(repoOf(deps).inputBox.value).toBe('feat: add login flow');
    });

    it('sends the diff with a system prompt and 512 max tokens', async () => {
        const deps = makeDeps();
        const manager = new CommitMessageManager(deps);

        await manager.generateIntoInputBox();

        expect(deps.complete).toHaveBeenCalledTimes(1);
        const [model, context, options] = deps.complete.mock.calls[0];
        // no session/configured model -> the fallback is picked
        expect(model).toEqual({ id: 'fallback-model' });
        expect(context.systemPrompt).toBe(COMMIT_MESSAGE_SYSTEM_PROMPT);
        expect(JSON.stringify(context.messages[0])).toContain('diff --git staged-change');
        expect(options.maxTokens).toBe(512);
        expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('prefers the active session model over configured and fallback', async () => {
        const sessionModel = { id: 'session-model' };
        const configured = { id: 'configured-model' };
        const deps = makeDeps({
            getSessionModel: async () => sessionModel,
            getConfiguredModel: async () => configured,
        });
        const manager = new CommitMessageManager(deps);

        await manager.generateIntoInputBox();

        expect(deps.complete.mock.calls[0][0]).toBe(sessionModel);
    });

    it('uses the configured model when no session model exists', async () => {
        const configured = { id: 'configured-model' };
        const deps = makeDeps({ getConfiguredModel: async () => configured });
        const manager = new CommitMessageManager(deps);

        await manager.generateIntoInputBox();

        expect(deps.complete.mock.calls[0][0]).toBe(configured);
    });

    it('reports noGitExtension without touching the input box', async () => {
        const deps = makeDeps();
        deps.gitApi = undefined;
        const manager = new CommitMessageManager(deps);

        const result = await manager.generateIntoInputBox();

        expect(result).toEqual({ ok: false, reason: 'noGitExtension' });
        expect(deps.complete).not.toHaveBeenCalled();
        expect(deps.showMessage).toHaveBeenCalled();
    });

    it('reports noRepository when git exposes no repositories', async () => {
        const deps = makeDeps();
        deps.gitApi = { repositories: [] };
        const manager = new CommitMessageManager(deps);

        const result = await manager.generateIntoInputBox();

        expect(result).toEqual({ ok: false, reason: 'noRepository' });
        expect(deps.complete).not.toHaveBeenCalled();
    });

    it('reports noChanges when staged and unstaged diffs are both empty', async () => {
        const deps = makeDeps();
        repoOf(deps).diff = vi.fn(async () => '  \n');
        const manager = new CommitMessageManager(deps);

        const result = await manager.generateIntoInputBox();

        expect(result).toEqual({ ok: false, reason: 'noChanges' });
        expect(deps.complete).not.toHaveBeenCalled();
        expect(deps.showMessage).toHaveBeenCalled();
    });

    it('reports noModel when no model source yields anything', async () => {
        const deps = makeDeps({ getFallbackModel: async () => undefined });
        const manager = new CommitMessageManager(deps);

        const result = await manager.generateIntoInputBox();

        expect(result).toEqual({ ok: false, reason: 'noModel' });
        expect(deps.complete).not.toHaveBeenCalled();
    });

    it('restores the previous input box content when generation fails', async () => {
        const deps = makeDeps({
            complete: vi.fn(async () => { throw new Error('provider down'); }),
        });
        repoOf(deps).inputBox.value = 'my hand-written message';
        const manager = new CommitMessageManager(deps);

        const result = await manager.generateIntoInputBox();

        expect(result).toEqual({ ok: false, reason: 'error' });
        expect(repoOf(deps).inputBox.value).toBe('my hand-written message');
        expect(deps.showMessage).toHaveBeenCalled();
    });

    it('restores the input box when the reply has no usable message', async () => {
        const deps = makeDeps({
            complete: vi.fn(async () => ({ content: [{ type: 'text', text: '```\n```' }] })),
        });
        repoOf(deps).inputBox.value = 'keep me';
        const manager = new CommitMessageManager(deps);

        const result = await manager.generateIntoInputBox();

        expect(result).toEqual({ ok: false, reason: 'error' });
        expect(repoOf(deps).inputBox.value).toBe('keep me');
    });

    it('reports an error when the diff cannot be read', async () => {
        const deps = makeDeps();
        repoOf(deps).diff = vi.fn(async () => { throw new Error('index.lock: unable to create'); });
        const manager = new CommitMessageManager(deps);

        const result = await manager.generateIntoInputBox();

        expect(result).toEqual({ ok: false, reason: 'error' });
        expect(repoOf(deps).inputBox.value).toBe('');
        expect(deps.showMessage).toHaveBeenCalledWith(expect.stringContaining('index.lock'));
    });

    it('surfaces provider errors carried by stopReason', async () => {
        const deps = makeDeps({
            complete: vi.fn(async () => ({
                stopReason: 'error',
                errorMessage: '401 invalid credentials',
                content: [],
            })),
        });
        const manager = new CommitMessageManager(deps);

        const result = await manager.generateIntoInputBox();

        expect(result).toEqual({ ok: false, reason: 'error' });
        expect(deps.showMessage).toHaveBeenCalledWith(expect.stringContaining('401 invalid credentials'));
    });

    it('reports truncation when the reply hits maxTokens', async () => {
        const deps = makeDeps({
            complete: vi.fn(async () => ({
                stopReason: 'length',
                content: [{ type: 'text', text: 'feat: half a thought' }],
            })),
        });
        const manager = new CommitMessageManager(deps);

        const result = await manager.generateIntoInputBox();

        expect(result).toEqual({ ok: false, reason: 'error' });
        expect(repoOf(deps).inputBox.value).toBe('');
    });

    it('uses the repository handed in by the scm menu when recognizable', async () => {
        const deps = makeDeps();
        const ws = makeRepo('/ws');
        const other = makeRepo('/other');
        deps.gitApi = { repositories: [ws, other] };
        const manager = new CommitMessageManager(deps);

        await manager.generateIntoInputBox(other);

        expect(other.inputBox.value).toBe('feat: add login flow');
        expect(ws.inputBox.value).toBe('');
    });

    it('ignores a concurrent second click while generating', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const deps = makeDeps({
            complete: vi.fn(async () => {
                await gate;
                return { content: [{ type: 'text', text: 'feat: slow' }] };
            }),
        });
        const manager = new CommitMessageManager(deps);

        const first = manager.generateIntoInputBox();
        const second = await manager.generateIntoInputBox();
        expect(second).toEqual({ ok: false, reason: 'inProgress' });
        // Re-entry is silently ignored — no dialog spam on rapid clicks.
        expect(deps.showMessage).not.toHaveBeenCalled();
        expect(manager.isGenerating).toBe(true);

        release();
        expect(await first).toEqual({ ok: true, message: 'feat: slow' });
        expect(deps.complete).toHaveBeenCalledTimes(1);
        expect(manager.isGenerating).toBe(false);
    });

    it('picks the repository matching the first workspace folder', async () => {
        const home = makeRepo('/other');
        const ws = makeRepo('/ws');
        const deps = makeDeps();
        deps.gitApi = { repositories: [home, ws] };
        const manager = new CommitMessageManager(deps);

        await manager.generateIntoInputBox();

        expect(ws.inputBox.value).toBe('feat: add login flow');
        expect(home.inputBox.value).toBe('');
    });

    it('falls back to the first repository when no workspace folder matches', async () => {
        h.workspaceFolders = [{ uri: { fsPath: '/elsewhere' } }];
        const first = makeRepo('/other');
        const deps = makeDeps();
        deps.gitApi = { repositories: [first] };
        const manager = new CommitMessageManager(deps);

        const result = await manager.generateIntoInputBox();

        expect(result.ok).toBe(true);
        expect(first.inputBox.value).toBe('feat: add login flow');
    });
});
