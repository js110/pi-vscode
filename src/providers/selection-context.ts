/**
 * Copilot-style selection awareness (user request 2026-09-16): the active
 * editor's non-empty selection shows up as a chip above the prompt input, and
 * the next plain text prompt automatically carries the selection's code as
 * context (one-shot — the chip clears after it is consumed or dismissed).
 * Display info and code live on the host side only; the webview never sees
 * the source text.
 *
 * Focusing the panel clears `window.activeTextEditor` (VS Code #180720), so
 * the editor/selection that a chip refers to is snapshotted while the editor
 * is still active and reused at send time — otherwise clicking into the input
 * would kill the chip and the wrap would never attach.
 */

import * as vscode from 'vscode';
import { t } from '../shared/i18n';
import type { ServerMessage, SelectionContextInfo } from '../shared/protocol';
import {
    buildSelectionPrompt,
    isSelectionTooLarge,
    selectionLineRange,
    MAX_SELECTION_CHARS,
} from './send-to-pi';

const DEBOUNCE_MS = 150;

interface LiveSelection extends SelectionContextInfo {
    languageId: string;
    code: string;
}

export class SelectionContextTracker implements vscode.Disposable {
    private _current: SelectionContextInfo | null = null;
    /** Snapshot backing the currently shown chip. */
    private _live: LiveSelection | null = null;
    /** Snapshot saved by the last consume, for reinstate after a failed send. */
    private _priorLive: LiveSelection | null = null;
    private _timer: ReturnType<typeof setTimeout> | undefined;
    private _disposables: vscode.Disposable[] = [];

    constructor(
        private _post: (msg: ServerMessage) => void,
        private _notify: (message: string) => void,
        private _debounceMs: number = DEBOUNCE_MS,
    ) {
        this._disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this._schedule()),
            vscode.window.onDidChangeTextEditorSelection(() => this._schedule()),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document === vscode.window.activeTextEditor?.document) {
                    this._schedule();
                }
            }),
        );
    }

    /** Chip info currently shown in the webview (null when none). */
    get current(): SelectionContextInfo | null {
        return this._current;
    }

    /**
     * One-shot: wrap `text` with the snapshotted selection's code and clear
     * the chip. Returns null when no chip is showing — the caller then sends
     * the plain text. An oversized selection is reported and dropped rather
     * than blocking the message. The snapshot can be brought back with
     * {@link reinstate} if the send turns out to have failed.
     */
    consumePrompt(text: string): string | null {
        const live = this._live;
        if (!live) return null;
        if (isSelectionTooLarge(live.code)) {
            this._notify(t('sendToPi.tooLarge', { n: MAX_SELECTION_CHARS }));
            this._forget();
            return null;
        }
        const prompt = buildSelectionPrompt({
            displayPath: live.path,
            startLine: live.startLine,
            endLine: live.endLine,
            languageId: live.languageId,
            code: live.code,
        });
        this._priorLive = live;
        this._forget();
        return `${prompt}\n\n${text}`;
    }

    /** Webview dismissed the chip. */
    dismiss(): void {
        this._forget();
    }

    /** Bring back a chip consumed by {@link consumePrompt} (failed dispatch). */
    reinstate(info: SelectionContextInfo | null): void {
        this._live = info ? this._priorLive : null;
        this._priorLive = null;
        this._setActive(info);
    }

    dispose(): void {
        if (this._timer !== undefined) clearTimeout(this._timer);
        for (const d of this._disposables) d.dispose();
        this._disposables = [];
    }

    private _schedule(): void {
        if (this._timer !== undefined) clearTimeout(this._timer);
        this._timer = setTimeout(() => {
            this._timer = undefined;
            this._refresh();
        }, this._debounceMs);
    }

    private _refresh(): void {
        const editor = vscode.window.activeTextEditor;
        // No active editor = the user is focused on a webview/panel. Keep the
        // chip exactly as it is; only a real editor (or empty selection in one)
        // may change or clear it.
        if (!editor) return;
        const { start, end } = selectionLineRange(
            editor.selection.start.line,
            editor.selection.end.line,
            editor.selection.end.character,
        );
        const info: SelectionContextInfo | null = editor.selection.isEmpty
            ? null
            : {
                path: vscode.workspace.asRelativePath(editor.document.uri).replace(/\\/g, '/'),
                startLine: start,
                endLine: end,
            };
        this._live = info
            ? {
                ...info,
                languageId: editor.document.languageId,
                code: editor.document.getText(editor.selection),
            }
            : null;
        this._setActive(info);
    }

    private _forget(): void {
        // _priorLive deliberately survives: reinstate() needs it to restore
        // the snapshot when the send that consumed the chip turns out to have
        // failed. It is overwritten by the next consume.
        this._live = null;
        this._setActive(null);
    }

    private _setActive(info: SelectionContextInfo | null): void {
        const prev = this._current;
        this._current = info;
        if (prev?.path !== info?.path
            || prev?.startLine !== info?.startLine
            || prev?.endLine !== info?.endLine) {
            this._post({ type: 'selectionChanged', selection: info });
        }
    }
}
