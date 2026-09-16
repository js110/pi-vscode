/**
 * SCM commit-message generation (PRD C10, §2.3 of tech-doc): a button next
 * to the Source Control input box fills in an AI-written message from the
 * current staged/unstaged diff. Fill-only — the user reviews, edits and
 * commits themselves (AC-FN-16).
 */

import * as vscode from 'vscode';
import { t } from '../shared/i18n';
import {
    pickCommitDiffSource,
    truncateCommitDiff,
    buildCommitMessagePrompt,
    extractCommitMessage,
    COMMIT_MESSAGE_SYSTEM_PROMPT,
} from '../shared/commit-message';

/** Minimal surface of the vscode.git extension API used here. */
export interface CommitGitRepository {
    readonly rootUri: vscode.Uri;
    inputBox: { value: string };
    diff(cached?: boolean): Promise<string>;
}

export interface CommitGitApi {
    repositories: CommitGitRepository[];
}

export interface CommitMessageDeps {
    getGitApi(): CommitGitApi | undefined;
    /** Model of the active tab's session, if any. */
    getSessionModel(): Promise<unknown>;
    /** Model resolved from the VS Code defaultModel setting, if any. */
    getConfiguredModel(): Promise<unknown>;
    /** Last-resort model (first available in the registry). */
    getFallbackModel(): Promise<unknown>;
    complete(
        model: unknown,
        context: { systemPrompt: string; messages: unknown[] },
        options: { maxTokens: number; signal?: AbortSignal },
    ): Promise<unknown>;
    showMessage(message: string): void;
}

export type CommitGenerationResult =
    | { ok: true; message: string }
    | { ok: false; reason: 'inProgress' | 'noGitExtension' | 'noRepository' | 'noChanges' | 'noModel' | 'error' };

export class CommitMessageManager {
    private _generating = false;

    constructor(private _deps: CommitMessageDeps) {}

    get isGenerating(): boolean {
        return this._generating;
    }

    async generateIntoInputBox(target?: unknown): Promise<CommitGenerationResult> {
        // The flag must flip synchronously: two rapid clicks would both
        // pass an await-deferred check and run concurrent generations.
        // A second click while busy is silently ignored (no error dialog).
        if (this._generating) {
            return { ok: false, reason: 'inProgress' };
        }
        this._generating = true;
        try {
            return await this._generate(target);
        } catch (err: any) {
            // Model resolution / SDK loading / git API failures land here
            // (before the placeholder is written, so nothing to restore).
            this._deps.showMessage(`${t('commit.failed')} ${err?.message ?? err}`.trim());
            return { ok: false, reason: 'error' };
        } finally {
            this._generating = false;
        }
    }

    private async _generate(target?: unknown): Promise<CommitGenerationResult> {
        const gitApi = this._deps.getGitApi();
        if (!gitApi) {
            this._deps.showMessage(t('commit.noGit'));
            return { ok: false, reason: 'noGitExtension' };
        }
        const repo = this._pickRepository(gitApi, target);
        if (!repo) {
            this._deps.showMessage(t('commit.noRepository'));
            return { ok: false, reason: 'noRepository' };
        }

        // A failing diff (repository lock, …) surfaces as an error instead
        // of masquerading as "no changes".
        const [staged, unstaged] = await Promise.all([repo.diff(true), repo.diff(false)]);
        const source = pickCommitDiffSource(staged, unstaged);
        if (!source) {
            this._deps.showMessage(t('commit.noChanges'));
            return { ok: false, reason: 'noChanges' };
        }

        const model = (await this._deps.getSessionModel())
            ?? (await this._deps.getConfiguredModel())
            ?? (await this._deps.getFallbackModel());
        if (!model) {
            this._deps.showMessage(t('commit.noModel'));
            return { ok: false, reason: 'noModel' };
        }

        const prompt = buildCommitMessagePrompt(truncateCommitDiff(source.diff), source.staged);
        // The placeholder overwrites the box; keep the user's text so a
        // failure restores it instead of silently discarding it.
        const placeholder = t('commit.generatingPlaceholder');
        const previous = repo.inputBox.value;
        repo.inputBox.value = placeholder;
        try {
            const assistant = await this._deps.complete(model, {
                systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
                messages: [
                    { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() },
                ],
            }, {
                maxTokens: 512,
                // A hung provider must not leave the placeholder (and the
                // re-entry lock) in place forever.
                signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
            });
            assertSucceeded(assistant);
            const message = extractCommitMessage(extractAssistantText(assistant));
            if (!message) throw new Error('the model returned no commit message');
            repo.inputBox.value = message;
            return { ok: true, message };
        } catch (err: any) {
            // Restore only when the user hasn't started typing meanwhile —
            // their input wins over the placeholder bookkeeping.
            if (repo.inputBox.value === placeholder) {
                repo.inputBox.value = previous;
            }
            this._deps.showMessage(`${t('commit.failed')} ${err?.message ?? err}`.trim());
            return { ok: false, reason: 'error' };
        }
    }

    private _pickRepository(gitApi: CommitGitApi, target?: unknown): CommitGitRepository | undefined {
        // The scm/inputBox menu may hand us the repository it belongs to;
        // duck-type rather than trust the shape blindly.
        const candidate = target as CommitGitRepository | undefined;
        if (candidate
            && typeof candidate === 'object'
            && candidate.inputBox
            && typeof candidate.diff === 'function'
            && candidate.rootUri
        ) {
            return candidate;
        }
        const repos = gitApi.repositories;
        if (repos.length === 0) return undefined;
        // Windows drive letters differ in case across git/VS Code APIs.
        const roots = (vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [])
            .map(normalizeFsPath);
        return repos.find((r) => roots.includes(normalizeFsPath(r.rootUri.fsPath))) ?? repos[0];
    }
}

function normalizeFsPath(p: string): string {
    return process.platform === 'win32' ? p.toLowerCase() : p;
}

const GENERATION_TIMEOUT_MS = 120_000;

/** completeSimple resolves (not rejects) on provider errors — surface them. */
function assertSucceeded(assistant: unknown): void {
    const a = assistant as { stopReason?: string; errorMessage?: string } | undefined;
    const stopReason = a?.stopReason;
    if (!stopReason || stopReason === 'stop') return;
    if (stopReason === 'length') {
        throw new Error('the generated message was truncated (increase the token budget)');
    }
    throw new Error(a?.errorMessage || `model error (${stopReason})`);
}

function extractAssistantText(assistant: unknown): string {
    if (typeof assistant === 'string') return assistant;
    const content = (assistant as { content?: unknown } | null)?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((c) => (c as { type?: string })?.type === 'text')
        .map((c) => String((c as { text?: string })?.text ?? ''))
        .join('');
}
