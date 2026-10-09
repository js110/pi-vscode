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
});
