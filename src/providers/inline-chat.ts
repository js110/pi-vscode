/**
 * Inline chat (PRD C13, spike decision §2.1 of tech-doc): a 100% stable-API
 * approximation of editor-anchored AI editing. The round belongs to the
 * active tab (a normal prompt dispatch, so tool calls ride the tab's
 * approval flow); the invoking file's changes are previewed as line
 * decorations computed from a base snapshot, and the whole round is
 * accepted or discarded at once through the tab's checkpoint chain
 * (AC-FN-11/12).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { t } from '../shared/i18n';
import { humanizeErrorMessage } from '../shared/error-copy';
import { parseChangedLineRanges } from '../shared/inline-diff';
import { computeUnifiedDiff } from '../utils/diff';
import { buildSelectionPrompt, selectionLineRange, isSelectionTooLarge } from './send-to-pi';
import type { TabManager } from './tab';
import type { FileChangeInfo } from '../shared/protocol';

export interface InlineChatDeps {
    getTabManager(): TabManager | undefined;
    showMessage(message: string): void;
    confirmDialog(message: string): Promise<boolean>;
    setContext(key: string, value: unknown): void;
}

interface InlineRound {
    tabId: string;
    /** Absolute fsPath of the invoking editor's file. */
    anchorPath: string;
    /** File content captured before the round's first turn. */
    anchorBase: string;
    /** Turn index the round's prompt occupies. */
    firstTurnIdx: number;
    phase: 'generating' | 'pendingReview';
    conflictNotified: boolean;
    /** Absolute paths of files written during the round. */
    trackedFiles: Set<string>;
    disposeRound: () => void;
}

export class InlineChatManager implements vscode.Disposable {
    private _round: InlineRound | null = null;
    private _changedDeco: vscode.TextEditorDecorationType;
    private _staleDeco: vscode.TextEditorDecorationType;
    private _acceptItem: vscode.StatusBarItem;
    private _discardItem: vscode.StatusBarItem;

    constructor(private _deps: InlineChatDeps) {
        this._changedDeco = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: 'rgba(46,160,67,0.18)',
        });
        this._staleDeco = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: 'rgba(128,128,128,0.15)',
        });
        this._acceptItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
        this._acceptItem.command = 'pi-agent.inlineAccept';
        this._discardItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this._discardItem.command = 'pi-agent.inlineDiscard';
    }

    /** True while a round is generating or awaiting review. */
    get active(): boolean {
        return this._round !== null;
    }

    async start(): Promise<void> {
        if (this._round) {
            this._deps.showMessage(t('inline.active'));
            return;
        }
        const tm = this._deps.getTabManager();
        if (!tm) return;
        await tm.initialize();
        if (!tm.activeTab) return;
        if (tm.isStreaming) {
            this._deps.showMessage(t('inline.busy'));
            return;
        }
        if (tm.isReadOnlyLocked()) {
            this._deps.showMessage(t('occupancy.readOnlyBlocked'));
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        if (editor.document.isDirty) {
            const ok = await this._deps.confirmDialog(t('inline.dirtySave'));
            if (!ok) return;
            try {
                await editor.document.save();
            } catch (err: unknown) {
                const text = humanizeErrorMessage(err);
                if (text) this._deps.showMessage(text);
                return;
            }
            if (editor.document.isDirty) return;
        }

        const selection = editor.selection;
        const code = selection.isEmpty
            ? editor.document.getText()
            : editor.document.getText(selection);
        if (isSelectionTooLarge(code)) {
            this._deps.showMessage(t('sendToPi.tooLarge', { n: 40_000 }));
            return;
        }

        const instruction = await this._collectInstruction();
        if (!instruction) return;
        await this._beginRound(tm, editor, instruction, selection);
    }

    accept(): void {
        if (!this._round || this._round.phase !== 'pendingReview') return;
        this._cleanup();
        this._deps.showMessage(t('inline.accepted'));
    }

    async discard(): Promise<void> {
        const round = this._round;
        if (!round || round.phase !== 'pendingReview') return;

        const tm = this._deps.getTabManager();
        // A follow-up may be streaming on the round's tab after settle —
        // rolling files back mid-turn would corrupt the running agent.
        if (tm?.isTabStreaming(round.tabId)) {
            this._deps.showMessage(t('inline.busy'));
            return;
        }

        const editor = this._findEditor(round.anchorPath);
        let confirmed: boolean;
        if (editor && (editor.document.isDirty || editor.document.getText() !== this._readFile(round.anchorPath))) {
            confirmed = await this._deps.confirmDialog(t('inline.discardConflictConfirm'));
        } else {
            confirmed = await this._deps.confirmDialog(t('inline.discardConfirm'));
        }
        if (!confirmed) return;

        if (tm) {
            try {
                await tm.restoreCheckpointOnTab(round.tabId, round.firstTurnIdx - 1);
            } catch (err: unknown) {
                // Keep the pending state so the user can retry.
                const text = humanizeErrorMessage(err);
                if (text) this._deps.showMessage(text);
                return;
            }
        }
        this._cleanup();
        this._deps.showMessage(t('inline.discarded'));
    }

    dispose(): void {
        this._cleanup();
        this._changedDeco.dispose();
        this._staleDeco.dispose();
        this._acceptItem.dispose();
        this._discardItem.dispose();
    }

    // ── Round lifecycle ──

    private async _collectInstruction(): Promise<string | undefined> {
        const input = vscode.window.createInputBox();
        input.title = t('inline.promptTitle');
        input.placeholder = t('inline.inputPlaceholder');
        return await new Promise<string | undefined>((resolve) => {
            let done = false;
            const settle = (value: string | undefined): void => {
                if (done) return;
                done = true;
                resolve(value);
            };
            input.onDidAccept(() => settle(input.value.trim() || undefined));
            input.onDidHide(() => settle(undefined));
            input.show();
        }).finally(() => input.dispose());
    }

    private async _beginRound(
        tm: TabManager,
        editor: vscode.TextEditor,
        instruction: string,
        selection: vscode.Selection,
    ): Promise<void> {
        const tab = tm.activeTab;
        if (!tab) return;
        const anchorPath = editor.document.uri.fsPath;
        const anchorBase = editor.document.getText();

        const prompt = instruction + '\n\n' + this._buildContext(editor, selection);

        // Subscribe BEFORE dispatching: session.prompt resolves only after the
        // whole agent turn has run, so post-dispatch wiring would miss every
        // event of the round.
        const unsubs: (() => void)[] = [];
        unsubs.push(tab.diffManager.onFileChange((change) => this._onFileChange(change)));
        unsubs.push(tab.session.events.on('agent_settled', () => this._onSettled()));
        const docSub = vscode.workspace.onDidChangeTextDocument((e) => this._onDocumentChange(e));
        const editorSub = vscode.window.onDidChangeActiveTextEditor(() => this._applyDecorations());
        unsubs.push(() => docSub.dispose(), () => editorSub.dispose());

        const round: InlineRound = {
            tabId: tab.id,
            anchorPath,
            anchorBase,
            firstTurnIdx: -1,
            phase: 'generating',
            conflictNotified: false,
            trackedFiles: new Set<string>(),
            disposeRound: () => {
                for (const unsub of unsubs) unsub();
            },
        };
        this._round = round;
        this._updateStatusItems();

        // dispatch() is async and yields before turnCounter++; capture the
        // *next* turn index so discard() restores to the correct boundary.
        const dispatching = tm.dispatch({ type: 'prompt', text: prompt, bypassSlashCommands: true });
        round.firstTurnIdx = (tm.getTurnCounter(tab.id) ?? 0) + 1;

        try {
            await dispatching;
        } catch (err: unknown) {
            if (this._round === round) {
                this._cleanup();
                const text = humanizeErrorMessage(err);
                if (text) this._deps.showMessage(text);
            }
        }
    }

    private _buildContext(editor: vscode.TextEditor, selection: vscode.Selection): string {
        const doc = editor.document;
        const displayPath = vscode.workspace.asRelativePath(doc.uri);
        if (selection.isEmpty) {
            const code = doc.getText();
            return buildSelectionPrompt({
                displayPath,
                startLine: 1,
                endLine: Math.max(1, doc.lineCount),
                languageId: doc.languageId,
                code,
            });
        }
        const range = selectionLineRange(selection.start.line, selection.end.line, selection.end.character);
        return buildSelectionPrompt({
            displayPath,
            startLine: range.start,
            endLine: range.end,
            languageId: doc.languageId,
            code: doc.getText(selection),
        });
    }

    private _onFileChange(change: FileChangeInfo): void {
        const round = this._round;
        if (!round) return;
        if (change.turnIndex < round.firstTurnIdx) return;
        const abs = this._resolveFilePath(change.filePath);
        round.trackedFiles.add(abs);
        if (abs === round.anchorPath) {
            this._applyDecorations();
        }
    }

    private _onSettled(): void {
        const round = this._round;
        if (!round || round.phase !== 'generating') return;
        if (round.trackedFiles.size === 0) {
            // Nothing landed — no review needed.
            this._cleanup();
            return;
        }
        round.phase = 'pendingReview';
        this._applyDecorations();
        this._updateStatusItems();
    }

    private _onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
        const round = this._round;
        if (!round || round.phase !== 'generating' || round.conflictNotified) return;
        if (e.document.uri.fsPath !== round.anchorPath) return;
        // Tool writes go straight to disk; a dirty buffer during generation
        // means the user is typing over the same file (AC-FN-12).
        if (e.document.isDirty) {
            round.conflictNotified = true;
            this._deps.showMessage(t('inline.conflictNotice'));
        }
    }

    // ── Decorations & status ──

    private _applyDecorations(): void {
        const round = this._round;
        const editor = round ? this._findEditor(round.anchorPath) : undefined;
        if (!round || !editor) return;

        const current = this._readFile(round.anchorPath);
        if (current === null) return;
        const { diff } = computeUnifiedDiff(round.anchorBase, current, round.anchorPath);
        const ranges = parseChangedLineRanges(diff);
        const deco = round.phase === 'generating' ? this._changedDeco : this._staleDeco;
        editor.setDecorations(deco, ranges.map((r) => new vscode.Range(r.start, 0, r.end, 0)));
        const other = round.phase === 'generating' ? this._staleDeco : this._changedDeco;
        editor.setDecorations(other, []);
    }

    private _updateStatusItems(): void {
        const round = this._round;
        const show = !!round && round.phase === 'pendingReview';
        if (show) {
            this._acceptItem.text = `$(check) ${t('inline.statusAccept')}`;
            this._acceptItem.tooltip = t('inline.statusTitle');
            this._discardItem.text = `$(x) ${t('inline.statusDiscard')}`;
            this._discardItem.tooltip = t('inline.statusTitle');
            this._acceptItem.show();
            this._discardItem.show();
        } else {
            this._acceptItem.hide();
            this._discardItem.hide();
        }
        this._deps.setContext('pi-agent.inlinePending', show);
    }

    private _cleanup(): void {
        const round = this._round;
        if (!round) return;
        this._round = null;
        round.disposeRound();
        const editor = this._findEditor(round.anchorPath);
        if (editor) {
            editor.setDecorations(this._changedDeco, []);
            editor.setDecorations(this._staleDeco, []);
        }
        this._updateStatusItems();
    }

    // ── Helpers ──

    private _findEditor(fsPath: string): vscode.TextEditor | undefined {
        return vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === fsPath);
    }

    private _readFile(fsPath: string): string | null {
        try {
            return fs.readFileSync(fsPath, 'utf-8');
        } catch {
            return null;
        }
    }

    private _resolveFilePath(filePath: string): string {
        if (filePath.startsWith('~/') || filePath === '~') {
            const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
            filePath = path.join(home, filePath.slice(2));
        }
        if (path.isAbsolute(filePath)) return filePath;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return root ? path.join(root, filePath) : path.resolve(filePath);
    }
}
