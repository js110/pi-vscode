import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { computeLineDiff } from '../shared/line-diff';
import { langToExtensions, rankCandidates, newFileName } from '../shared/apply';
import { t } from '../shared/i18n';
import type { ApplyPreviewInfo } from '../shared/protocol';

export interface ApplyConfirmResult {
    ok: boolean;
    message?: string;
}

interface PendingPreview {
    info: ApplyPreviewInfo;
    /** On-disk content at preview time; null when the target did not exist. */
    oldText: string | null;
    createdAt: number;
    tabId: string;
}

const MAX_PENDING_PREVIEWS = 10;
const PREVIEW_TTL_MS = 10 * 60 * 1000;

/**
 * Apply-a-code-block flow (PRD C3): pick a target file, compute a line diff
 * preview, and on confirmation write the file — guarding against the target
 * being modified between preview and confirm (PRD 11.2). Pre-apply content is
 * snapshotted into the owning tab's CheckpointManager so an apply can be
 * undone in one step.
 */
export class ApplyManager {
    private _pending = new Map<string, PendingPreview>();
    private _seq = 0;

    constructor(
        private readonly _recordSnapshot?: (tabId: string, filePath: string, content: string | null) => void,
    ) {}

    async buildPreview(code: string, lang: string, tabId: string): Promise<ApplyPreviewInfo | null> {
        const extensions = langToExtensions(lang);

        let candidates: string[] = [];
        if (extensions.length > 0) {
            const pattern = `**/*.{${extensions.join(',')}}`;
            const uris = await vscode.workspace.findFiles(
                pattern,
                '**/{node_modules,.git,.pi,dist,out}/**',
                200,
            );
            candidates = rankCandidates(
                uris.map((u) => u.fsPath),
                extensions,
            );
        }

        let targetPath: string;
        let isNew = false;
        if (candidates.length === 1) {
            targetPath = candidates[0];
        } else if (candidates.length > 1) {
            const picked = await vscode.window.showQuickPick(
                candidates.map((p) => ({
                    label: path.basename(p),
                    description: path.dirname(p),
                    target: p,
                })),
                { placeHolder: t('apply.pickTarget') },
            );
            if (!picked) {
                return null; // user dismissed the picker — not an error
            }
            targetPath = picked.target;
        } else {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!root) {
                throw new Error(t('apply.noWorkspace'));
            }
            targetPath = path.join(root, newFileName(extensions[0] ?? 'txt', new Date()));
            isNew = true;
        }

        // Read content first, then sample the mtime: an external write in
        // between yields stale content with fresh mtime, which errs toward
        // overwriting with the (intended) code block rather than a false pass.
        let oldText: string | null = null;
        if (!isNew) {
            try {
                oldText = fs.readFileSync(targetPath, 'utf-8');
            } catch {
                oldText = null; // target vanished between listing and read
                isNew = true;
            }
        }

        const { diff, added, removed } = computeLineDiff(oldText ?? '', code);
        const previewId = `ap-${++this._seq}-${Date.now()}`;
        const info: ApplyPreviewInfo = {
            previewId,
            targetPath,
            isNew,
            diff,
            addedLines: added,
            removedLines: removed,
            code,
        };

        this._pruneExpired();
        if (this._pending.size >= MAX_PENDING_PREVIEWS) {
            const oldest = this._pending.keys().next().value;
            if (oldest !== undefined) this._pending.delete(oldest);
        }
        this._pending.set(previewId, { info, oldText, createdAt: Date.now(), tabId });
        return info;
    }

    async confirm(previewId: string): Promise<ApplyConfirmResult> {
        const pending = this._pending.get(previewId);
        if (!pending) {
            return { ok: false, message: t('apply.expired') };
        }
        this._pending.delete(previewId);

        const { info, oldText, tabId } = pending;

        // Conflict guard (PRD 11.2): on-disk content must be byte-identical to
        // what was previewed, which also catches low-precision-mtime filesystems.
        let currentText: string | null = null;
        try {
            currentText = fs.readFileSync(info.targetPath, 'utf-8');
        } catch {
            currentText = null;
        }
        if (oldText === null && currentText !== null) {
            return { ok: false, message: t('apply.exists') };
        }
        if (oldText !== null && currentText === null) {
            return { ok: false, message: t('apply.deleted') };
        }
        if (oldText !== null && currentText !== null && currentText !== oldText) {
            return { ok: false, message: t('apply.conflict') };
        }

        if (this._recordSnapshot) {
            this._recordSnapshot(tabId, info.targetPath, oldText);
        }

        try {
            const uri = vscode.Uri.file(info.targetPath);
            if (info.isNew) {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(info.targetPath)));
                await vscode.workspace.fs.writeFile(uri, Buffer.from(info.code, 'utf-8'));
            } else {
                const doc = await vscode.workspace.openTextDocument(uri);
                // Unsaved editor edits are invisible to the disk guard above;
                // refuse rather than destroy them with the full-document replace.
                if (doc.isDirty) {
                    return { ok: false, message: t('apply.dirty') };
                }
                const end = doc.positionAt(doc.getText().length);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(uri, new vscode.Range(doc.positionAt(0), end), info.code);
                await vscode.workspace.applyEdit(edit);
                await doc.save();
            }
        } catch (err: any) {
            return { ok: false, message: t('apply.writeError', { message: String(err?.message ?? err) }) };
        }

        const fileName = path.basename(info.targetPath);
        return {
            ok: true,
            message: info.isNew ? t('apply.created', { path: fileName }) : t('apply.applied', { path: fileName }),
        };
    }

    cancel(previewId: string): void {
        this._pending.delete(previewId);
    }

    private _pruneExpired(): void {
        const now = Date.now();
        for (const [id, pending] of this._pending) {
            if (now - pending.createdAt > PREVIEW_TTL_MS) {
                this._pending.delete(id);
            }
        }
    }
}
