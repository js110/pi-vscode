import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { executeNativeCommand } from '../../../pi/native-commands';

afterEach(() => vi.restoreAllMocks());

describe('native commands', () => {
    const run = (session: any, name: string, args = '', runtime?: any) => executeNativeCommand({} as any, session, runtime, name, args);

    it('reloads resources through the session SDK without prompting', async () => {
        const session = { reload: vi.fn(async () => {}), prompt: vi.fn() };
        expect(await run(session, 'reload')).toEqual({ changed: true });
        expect(session.reload).toHaveBeenCalledOnce();
        expect(session.prompt).not.toHaveBeenCalled();
    });

    it('navigates nested tree entries and restores the SDK editor text', async () => {
        const session = {
            sessionManager: { getLeafId: () => 'leaf', getTree: () => [{ entry: { id: 'root', type: 'message', message: { role: 'user', content: 'hi' } }, children: [
                { entry: { id: 'target', type: 'message', message: { role: 'user', content: 'edit me' } }, children: [] },
            ] }] },
            navigateTree: vi.fn(async () => ({ cancelled: false, editorText: 'edit me' })),
        };
        vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue('No summary' as any);
        expect(await run(session, 'tree', 'target')).toEqual({ changed: true, editorText: 'edit me' });
        expect(session.navigateTree).toHaveBeenCalledWith('target', { summarize: false });
    });

    it('does not navigate if the branch summary dialog is cancelled', async () => {
        const session = { sessionManager: { getLeafId: () => 'leaf', getTree: () => [{ entry: { id: 'target', type: 'custom' }, children: [] }] }, navigateTree: vi.fn() };
        expect(await run(session, 'tree', 'target')).toEqual({});
        expect(session.navigateTree).not.toHaveBeenCalled();
    });

    it('clones at the leaf using the native runtime and respects extension cancellation', async () => {
        const runtime = { fork: vi.fn(async () => ({ cancelled: true })) };
        const session = { sessionManager: { getLeafId: () => 'leaf' }, getUserMessagesForForking: () => [] };
        expect(await run(session, 'clone', '', runtime)).toEqual({});
        expect(runtime.fork).toHaveBeenCalledWith('leaf', { position: 'at' });
    });

    it('forks before the selected message and returns its draft', async () => {
        const runtime = { fork: vi.fn(async () => ({ cancelled: false, selectedText: 'original' })) };
        expect(await run({ getUserMessagesForForking: () => [] }, 'fork', 'user-entry', runtime)).toEqual({ changed: true, editorText: 'original' });
        expect(runtime.fork).toHaveBeenCalledWith('user-entry', { position: 'before' });
    });

    it('reports missing optional APIs explicitly', async () => {
        await expect(run({}, 'reload')).rejects.toThrow('does not provide reload');
    });

    it('passes Pi’s stable installation ID into subscription OAuth login', async () => {
        const login = vi.fn(async (_provider, _type, _interaction, options) => {
            expect(options.getDeviceId()).toBe('a0089492-613e-472f-b2a4-f9a814af5168');
        });
        const session = {
            settingsManager: { getOrCreateDeviceId: vi.fn(() => 'a0089492-613e-472f-b2a4-f9a814af5168') },
            modelRuntime: {
                getProviders: () => [],
                getProvider: () => ({ name: 'OpenAI', auth: { oauth: { name: 'ChatGPT' } } }),
                login,
            },
        };
        Object.defineProperty(vscode.window, 'withProgress', { configurable: true, value: (_options: unknown, task: Function) => task({ report: vi.fn() }, { onCancellationRequested: () => ({ dispose: vi.fn() }) }) });
        Object.defineProperty(vscode, 'ProgressLocation', { configurable: true, value: { Notification: 15 } });
        expect(await run(session, 'login', 'openai')).toEqual({ changed: true });
        expect(login).toHaveBeenCalledOnce();
        expect(session.settingsManager.getOrCreateDeviceId).toHaveBeenCalledOnce();
    });
});
