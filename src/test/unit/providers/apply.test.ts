import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ApplyManager } from '../../../providers/apply';

vi.mock('vscode', () => {
    const written: { uri: { fsPath: string }; content: Buffer }[] = [];
    return {
        workspace: {
            workspaceFolders: [{ uri: { fsPath: 'C:\\ws-root' } }],
            findFiles: vi.fn(async () => []),
            fs: {
                createDirectory: vi.fn(async () => {}),
                writeFile: vi.fn(async (uri: { fsPath: string }, content: Buffer) => {
                    written.push({ uri, content });
                }),
            },
            openTextDocument: vi.fn(),
            applyEdit: vi.fn(async () => true),
        },
        window: { showQuickPick: vi.fn() },
        Uri: { file: (p: string) => ({ fsPath: p }) },
        Range: class {
            constructor(public start: any, public end: any) {}
        },
        WorkspaceEdit: class {
            replace = vi.fn();
        },
        __written: written,
    };
});

const mocked = vscode as any;

function makeManager() {
    const snapshots: { tabId: string; filePath: string; content: string | null }[] = [];
    const manager = new ApplyManager((tabId, filePath, content) => {
        snapshots.push({ tabId, filePath, content });
    });
    return { manager, snapshots };
}

/** Restore pristine mock behaviour mutated by individual tests. */
function resetMockWorkspace(rootFsPath: string): void {
    mocked.workspace.workspaceFolders = [{ uri: { fsPath: rootFsPath } }];
    mocked.workspace.findFiles = vi.fn(async () => []);
    mocked.workspace.openTextDocument = vi.fn();
    mocked.window.showQuickPick = vi.fn();
}

describe('ApplyManager.buildPreview', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-apply-'));
        mocked.__written.length = 0;
        resetMockWorkspace('C:\\ws-root');
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it('throws for a new-file target when no workspace folder is open', async () => {
        mocked.workspace.workspaceFolders = [];
        const { manager } = makeManager();
        await expect(manager.buildPreview('x = 1', 'python', 'tab-1')).rejects.toThrow();
    });

    it('creates a new-file preview when no candidate files exist', async () => {
        const { manager } = makeManager();
        const preview = await manager.buildPreview('x = 1\ny = 2', 'python', 'tab-1');
        expect(preview).not.toBeNull();
        expect(preview!.isNew).toBe(true);
        expect(preview!.targetPath).toMatch(/pi-apply-\d{6}\.py$/);
        expect(preview!.addedLines).toBe(2);
        expect(preview!.removedLines).toBe(0);
    });

    it('auto-picks a single candidate and diffs against its on-disk content', async () => {
        const target = path.join(tmpDir, 'a.py');
        fs.writeFileSync(target, 'old\n', 'utf-8');
        mocked.workspace.findFiles = vi.fn(async () => [{ fsPath: target }]);
        const { manager } = makeManager();
        const preview = await manager.buildPreview('new\n', 'py', 'tab-1');
        expect(preview!.isNew).toBe(false);
        expect(preview!.targetPath).toBe(target);
        expect(preview!.diff.split('\n')).toEqual(['-old', '+new']);
    });

    it('returns null when the user dismisses the multi-candidate QuickPick', async () => {
        const f1 = path.join(tmpDir, 'a.py');
        const f2 = path.join(tmpDir, 'b.py');
        mocked.workspace.findFiles = vi.fn(async () => [{ fsPath: f1 }, { fsPath: f2 }]);
        mocked.window.showQuickPick = vi.fn(async () => undefined);
        const { manager } = makeManager();
        const preview = await manager.buildPreview('new\n', 'py', 'tab-1');
        expect(preview).toBeNull();
    });
});

describe('ApplyManager.confirm', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-apply-'));
        mocked.__written.length = 0;
        resetMockWorkspace(tmpDir);
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it('fails with the expired message for an unknown preview id', async () => {
        const { manager } = makeManager();
        const result = await manager.confirm('ap-does-not-exist');
        expect(result.ok).toBe(false);
        expect(result.message).toContain('expired');
    });

    it('writes a new file on confirm and snapshots null content', async () => {
        const { manager, snapshots } = makeManager();
        const preview = await manager.buildPreview('print("hi")\n', 'python', 'tab-1');
        const result = await manager.confirm(preview!.previewId);
        expect(result.ok).toBe(true);
        expect(mocked.__written).toHaveLength(1);
        expect(mocked.__written[0].content.toString('utf-8')).toBe('print("hi")\n');
        expect(snapshots).toEqual([
            { tabId: 'tab-1', filePath: preview!.targetPath, content: null },
        ]);
    });

    it('replaces an existing document via WorkspaceEdit and snapshots the pre-content', async () => {
        const target = path.join(tmpDir, 'a.py');
        fs.writeFileSync(target, 'old\n', 'utf-8');
        mocked.workspace.findFiles = vi.fn(async () => [{ fsPath: target }]);
        mocked.workspace.openTextDocument = vi.fn(async () => ({
            isDirty: false,
            getText: () => 'old\n',
            positionAt: (offset: number) => offset,
            save: vi.fn(async () => true),
        }));
        const { manager, snapshots } = makeManager();
        const preview = await manager.buildPreview('new\n', 'py', 'tab-1');
        const result = await manager.confirm(preview!.previewId);
        expect(result.ok, result.message ?? 'no message').toBe(true);
        expect(snapshots).toEqual([
            { tabId: 'tab-1', filePath: target, content: 'old\n' },
        ]);
        expect(mocked.workspace.applyEdit).toHaveBeenCalledOnce();
    });

    it('blocks confirm when the file was modified after preview (PRD 11.2)', async () => {
        const target = path.join(tmpDir, 'a.py');
        fs.writeFileSync(target, 'old\n', 'utf-8');
        mocked.workspace.findFiles = vi.fn(async () => [{ fsPath: target }]);
        const { manager } = makeManager();
        const preview = await manager.buildPreview('new\n', 'py', 'tab-1');
        fs.writeFileSync(target, 'externally edited\n', 'utf-8');
        const result = await manager.confirm(preview!.previewId);
        expect(result.ok).toBe(false);
        expect(result.message).toContain('preview');
        expect(fs.readFileSync(target, 'utf-8')).toBe('externally edited\n');
    });

    it('blocks confirm when a new-file target appeared after preview', async () => {
        const { manager } = makeManager();
        const preview = await manager.buildPreview('new\n', 'py', 'tab-1');
        // The new-file target lives under the (tmp) workspace root; simulate
        // the file appearing there between preview and confirm.
        fs.writeFileSync(preview!.targetPath, 'appeared\n', 'utf-8');
        const result = await manager.confirm(preview!.previewId);
        expect(result.ok).toBe(false);
        expect(result.message).toContain('exists');
    });

    it('blocks confirm when the target file was deleted after preview', async () => {
        const target = path.join(tmpDir, 'a.py');
        fs.writeFileSync(target, 'old\n', 'utf-8');
        mocked.workspace.findFiles = vi.fn(async () => [{ fsPath: target }]);
        const { manager } = makeManager();
        const preview = await manager.buildPreview('new\n', 'py', 'tab-1');
        fs.rmSync(target);
        const result = await manager.confirm(preview!.previewId);
        expect(result.ok).toBe(false);
        expect(result.message).toContain('deleted');
    });

    it('blocks confirm when the document has unsaved editor changes', async () => {
        const target = path.join(tmpDir, 'a.py');
        fs.writeFileSync(target, 'old\n', 'utf-8');
        mocked.workspace.findFiles = vi.fn(async () => [{ fsPath: target }]);
        mocked.workspace.openTextDocument = vi.fn(async () => ({
            isDirty: true,
            getText: () => 'old\n',
            positionAt: (offset: number) => offset,
            save: vi.fn(async () => true),
        }));
        const { manager } = makeManager();
        const preview = await manager.buildPreview('new\n', 'py', 'tab-1');
        const result = await manager.confirm(preview!.previewId);
        expect(result.ok).toBe(false);
        expect(result.message).toContain('unsaved');
        expect(mocked.workspace.applyEdit).not.toHaveBeenCalled();
    });

    it('drops the oldest pending preview beyond the cap of 10', async () => {
        const target = path.join(tmpDir, 'a.py');
        fs.writeFileSync(target, 'old\n', 'utf-8');
        mocked.workspace.findFiles = vi.fn(async () => [{ fsPath: target }]);
        const { manager } = makeManager();
        const first = await manager.buildPreview('v1\n', 'py', 'tab-1');
        for (let i = 0; i < 10; i++) {
            await manager.buildPreview(`v${i + 2}\n`, 'py', 'tab-1');
        }
        const result = await manager.confirm(first!.previewId);
        expect(result.ok).toBe(false);
        expect(result.message).toContain('expired');
    });

    it('cancel removes the pending preview', async () => {
        const { manager } = makeManager();
        const preview = await manager.buildPreview('new\n', 'py', 'tab-1');
        manager.cancel(preview!.previewId);
        const result = await manager.confirm(preview!.previewId);
        expect(result.ok).toBe(false);
    });
});
