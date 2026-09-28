import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { PiSessionManager } from '../pi/session';
import type { FileChangeInfo } from '../shared/protocol';
import type { CheckpointManager } from './checkpoint';
import { computeUnifiedDiff } from '../utils/diff';
import { resolveWorkspacePath } from '../utils/paths';
import { parseUnifiedHunks, applyHunkSelection, applyHunkSelectionToNew } from '../shared/unified-hunks';

interface PendingEdit {
    toolCallId: string;
    toolName: string;
    filePath: string;
    originalContent: string | null;
    turnIndex: number;
}

type FileChangeListener = (change: FileChangeInfo) => void;

/** Upper bound for retained change/original entries; oldest are evicted. */
const MAX_FILE_CHANGES = 500;

export class DiffManager implements vscode.Disposable {
    private _session: PiSessionManager;
    private _checkpoint: CheckpointManager;
    private _pendingEdits = new Map<string, PendingEdit>();
    private _fileChanges: FileChangeInfo[] = [];
    private _originalContents = new Map<string, string | null>();
    private _unsubscribers: (() => void)[] = [];
    private _listeners: FileChangeListener[] = [];
    private _currentTurn = 0;

    constructor(session: PiSessionManager, checkpoint: CheckpointManager) {
        this._session = session;
        this._checkpoint = checkpoint;

        this._unsubscribers.push(
            session.events.on('tool_execution_start', (event) => {
                this._onToolStart(event as any);
            }),
            session.events.on('tool_execution_end', (event) => {
                this._onToolEnd(event as any);
            }),
        );
    }

    get fileChanges(): FileChangeInfo[] {
        return this._fileChanges;
    }

    setCurrentTurn(turn: number): void {
        this._currentTurn = turn;
    }

    onFileChange(listener: FileChangeListener): () => void {
        this._listeners.push(listener);
        return () => {
            const idx = this._listeners.indexOf(listener);
            if (idx >= 0) this._listeners.splice(idx, 1);
        };
    }

    private _emitFileChange(change: FileChangeInfo): void {
        for (const listener of this._listeners) {
            listener(change);
        }
    }

    private async _onToolStart(event: any): Promise<void> {
        const name = event.toolName;
        if (name !== 'edit' && name !== 'write') return;

        const filePath = event.args?.file_path ?? event.args?.path ?? '';
        if (!filePath) return;

        let originalContent: string | null = null;
        try {
            const absPath = this._resolveFilePath(filePath);
            const data = fs.readFileSync(absPath, 'utf-8');
            originalContent = data;
        } catch {
            // file doesn't exist yet
        }

        this._checkpoint.recordFileState(filePath, originalContent);

        const absPath = this._resolveFilePath(filePath);
        if (!this._originalContents.has(absPath)) {
            this._originalContents.set(absPath, originalContent);
        }

        this._pendingEdits.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: name,
            filePath,
            originalContent,
            turnIndex: this._currentTurn,
        });
    }

    private async _onToolEnd(event: any): Promise<void> {
        const pending = this._pendingEdits.get(event.toolCallId);
        if (!pending) return;
        this._pendingEdits.delete(event.toolCallId);

        if (event.isError) return;

        const absPath = this._resolveFilePath(pending.filePath);
        let newContent: string | null = null;
        try {
            newContent = fs.readFileSync(absPath, 'utf-8');
        } catch {
            return;
        }

        const isNew = pending.originalContent === null;
        let diffText = '';
        let addedLines = 0;
        let removedLines = 0;

        if (!isNew && pending.originalContent !== null) {
            const { diff, stats } = computeUnifiedDiff(
                pending.originalContent,
                newContent,
                pending.filePath,
            );
            diffText = diff;
            addedLines = stats.added;
            removedLines = stats.removed;
        } else {
            const lines = newContent.split('\n');
            addedLines = lines.length;
            diffText = lines.map(l => `+${l}`).join('\n');
        }

        const change: FileChangeInfo = {
            filePath: pending.filePath,
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            isNew,
            diff: diffText,
            addedLines,
            removedLines,
            turnIndex: pending.turnIndex,
        };

        this._fileChanges.push(change);
        this._pruneCaches();
        this._emitFileChange(change);
    }

    /** Evict oldest change records, dropping originals that are no longer referenced. */
    private _pruneCaches(): void {
        const overflow = this._fileChanges.length - MAX_FILE_CHANGES;
        if (overflow <= 0) return;
        const removed = this._fileChanges.splice(0, overflow);
        const referenced = new Set(
            this._fileChanges.map(c => this._resolveFilePath(c.filePath))
        );
        for (const change of removed) {
            const absPath = this._resolveFilePath(change.filePath);
            if (!referenced.has(absPath)) {
                this._originalContents.delete(absPath);
            }
        }
    }

    async openDiff(filePath: string, toolCallId: string): Promise<void> {
        const absPath = this._resolveFilePath(filePath);
        const uri = vscode.Uri.file(absPath);
        const original = this._originalContents.get(absPath);

        if (original !== undefined && original !== null) {
            const diffProvider = this._getDiffContentProvider();
            const beforeUri = vscode.Uri.parse(
                `pi-diff:${filePath}?before=${encodeURIComponent(toolCallId)}`
            );
            diffProvider?.setContent(beforeUri, original);

            await vscode.commands.executeCommand(
                'vscode.diff',
                beforeUri,
                uri,
                `${path.basename(filePath)} (Pi edit)`,
                { preview: true },
            );
        } else {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch { /* file may have been deleted */ }
        }
    }

    /**
     * Apply only the selected hunks of a tool's diff to disk (per-hunk partial
     * application from the chat panel). The rebuild is anchored to the content
     * captured at the tool's start, so the selection always derives from that
     * same base. If anything else has since touched the file (a later turn, an
     * earlier partial apply, or a manual edit), we refuse rather than clobber
     * it — the panel can't rebase hunks onto unknown content. Writes the file,
     * then records a new file-change entry so rollback/checkpoint bookkeeping
     * stays intact (repeated applications replace that synthetic entry).
     */
    async applyHunks(
        filePath: string,
        toolCallId: string,
        hunkIndices: number[],
    ): Promise<{ ok: boolean; message?: string }> {
        const absPath = this._resolveFilePath(filePath);
        const change = this._fileChanges.find(
            (c) => this._resolveFilePath(c.filePath) === absPath && c.toolCallId === toolCallId,
        );
        if (!change) {
            return { ok: false, message: 'diff.noChange' };
        }
        const original = this._originalContents.get(absPath);
        if (!change.isNew && (original === undefined || original === null)) {
            return { ok: false, message: 'diff.noOriginal' };
        }

        if (!change.diff) {
            return { ok: false, message: 'diff.noHunks' };
        }
        const { hunks } = parseUnifiedHunks(change.diff);
        if (hunks.length === 0) {
            return { ok: false, message: 'diff.noHunks' };
        }
        const selected = new Set<number>(
            hunkIndices.filter((i) => i >= 0 && i < hunks.length),
        );
        if (selected.size === 0) {
            return { ok: false, message: 'diff.noHunksSelected' };
        }

        // Refuse when the file on disk isn't the untouched original or this
        // tool's full result (trailing-newline normalized) — a drifted file
        // can't be safely rebased onto `original`.
        const all = new Set(hunks.map((_, i) => i));
        const fullResult = change.isNew
            ? applyHunkSelectionToNew(hunks, all)
            : applyHunkSelection(original as string, hunks, all);
        const norm = (s: string) => (s.endsWith('\n') ? s.slice(0, -1) : s);
        let diskContent: string | null = null;
        try {
            diskContent = fs.readFileSync(absPath, 'utf-8');
        } catch { /* missing file counts as untouched */ }
        if (diskContent !== null) {
            const untouched = change.isNew
                ? norm(diskContent) === ''
                : original !== undefined && original !== null && norm(diskContent) === norm(original);
            if (!untouched && norm(diskContent) !== norm(fullResult)) {
                return { ok: false, message: 'diff.fileDrifted' };
            }
        }

        const result = change.isNew
            ? applyHunkSelectionToNew(hunks, selected)
            : applyHunkSelection(original as string, hunks, selected);

        try {
            fs.writeFileSync(absPath, result, 'utf-8');
        } catch (err: unknown) {
            return { ok: false, message: err instanceof Error ? err.message : 'diff.writeFailed' };
        }

        // Record the partial application as its own change so the original
        // diff + rollback snapshot remain valid. Replace any earlier synthetic
        // entry for this file so repeated applications don't accumulate dupes.
        const partialToolCallId = `${toolCallId}|hunks`;
        const existingPartial = this._fileChanges.findIndex(
            (c) => this._resolveFilePath(c.filePath) === absPath && c.toolCallId === partialToolCallId,
        );
        let diffText = '';
        let addedLines = 0;
        let removedLines = 0;
        if (original !== null && original !== undefined) {
            const { diff, stats } = computeUnifiedDiff(original, result, change.filePath);
            diffText = diff;
            addedLines = stats.added;
            removedLines = stats.removed;
        } else {
            const lines = result.split('\n');
            addedLines = lines.length;
            diffText = lines.map((l) => `+${l}`).join('\n');
        }
        const partialChange: FileChangeInfo = {
            filePath: change.filePath,
            toolCallId: partialToolCallId,
            toolName: 'edit',
            isNew: change.isNew,
            diff: diffText,
            addedLines,
            removedLines,
            turnIndex: change.turnIndex,
        };
        if (existingPartial >= 0) {
            this._fileChanges[existingPartial] = partialChange;
        } else {
            this._fileChanges.push(partialChange);
        }
        this._pruneCaches();
        this._emitFileChange(partialChange);
        return { ok: true };
    }

    async undoFileChange(filePath: string, _toolCallId: string): Promise<void> {
        const absPath = this._resolveFilePath(filePath);
        const original = this._originalContents.get(absPath);
        if (original === undefined) return;

        try {
            if (original === null) {
                if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
            } else {
                fs.writeFileSync(absPath, original, 'utf-8');
            }
        } catch { /* best effort */ }

        this._fileChanges = this._fileChanges.filter(c =>
            this._resolveFilePath(c.filePath) !== absPath
        );
        this._originalContents.delete(absPath);
    }

    private _suspendedChanges: FileChangeInfo[] = [];
    private _suspendedOriginals = new Map<string, string | null>();

    suspendChangesAfter(turnIndex: number): void {
        this._suspendedChanges = this._fileChanges.filter(c => c.turnIndex > turnIndex);
        this._fileChanges = this._fileChanges.filter(c => c.turnIndex <= turnIndex);

        const remainingPaths = new Set(
            this._fileChanges.map(c => this._resolveFilePath(c.filePath))
        );
        for (const absPath of [...this._originalContents.keys()]) {
            if (!remainingPaths.has(absPath)) {
                this._suspendedOriginals.set(absPath, this._originalContents.get(absPath)!);
                this._originalContents.delete(absPath);
            }
        }
    }

    redoChanges(): void {
        for (const change of this._suspendedChanges) {
            this._fileChanges.push(change);
        }
        for (const [absPath, content] of this._suspendedOriginals) {
            if (!this._originalContents.has(absPath)) {
                this._originalContents.set(absPath, content);
            }
        }
        this._suspendedChanges = [];
        this._suspendedOriginals.clear();
    }

    discardSuspended(): void {
        this._suspendedChanges = [];
        this._suspendedOriginals.clear();
    }

    clearAll(): void {
        this._fileChanges = [];
        this._originalContents.clear();
        this._pendingEdits.clear();
        this._suspendedChanges = [];
        this._suspendedOriginals.clear();
        this._currentTurn = 0;
    }

    private _resolveFilePath(filePath: string): string {
        return resolveWorkspacePath(filePath, { expandHome: true });
    }

    private _getDiffContentProvider(): DiffContentProvider | undefined {
        return DiffContentProvider.instance;
    }

    dispose(): void {
        for (const unsub of this._unsubscribers) {
            unsub();
        }
        this._pendingEdits.clear();
        this._listeners = [];
    }
}

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
    static instance: DiffContentProvider | undefined;
    private _contents = new Map<string, string>();
    private _disposables: vscode.Disposable[] = [];

    constructor() {
        DiffContentProvider.instance = this;
        // Virtual pi-diff documents are only meaningful while the diff editor
        // holds them open; drop the cached copy as soon as it closes so the
        // map does not grow unbounded across a session.
        this._disposables.push(
            vscode.workspace.onDidCloseTextDocument((document) => {
                this._contents.delete(document.uri.toString());
            }),
        );
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this._contents.get(uri.toString()) ?? '';
    }

    setContent(uri: vscode.Uri, content: string): void {
        this._contents.set(uri.toString(), content);
    }

    dispose(): void {
        DiffContentProvider.instance = undefined;
        for (const disposable of this._disposables) {
            disposable.dispose();
        }
        this._disposables = [];
        this._contents.clear();
    }
}
