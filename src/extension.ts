import * as vscode from 'vscode';
import * as path from 'path';
import { PiSessionManager } from './pi/session';
import { SidebarProvider } from './providers/sidebar';
import { TabManager, type Tab, type TabFactory, type TabManagerAdapters } from './providers/tab';
import { StatusBarManager } from './providers/status-bar';
import { SettingsPanel } from './providers/settings-panel';
import { resolveDisplayLang } from './providers/lang';

import { DiffManager, DiffContentProvider } from './providers/diff';
import { CheckpointManager } from './providers/checkpoint';
import { ApplyManager } from './providers/apply';
import { InlineChatManager } from './providers/inline-chat';
import { SelectionContextTracker } from './providers/selection-context';
import { CommitMessageManager, type CommitGitApi } from './providers/commit-message';
import { createNodeLockDeps } from './pi/session-lock';
import { getModelRuntime } from './pi/auth';
import { getModelRegistry, findConfiguredModel } from './pi/models';
import { setLang, t, thinkingLevelLabel } from './shared/i18n';
import { humanizeErrorMessage } from './shared/error-copy';
import { setSdkProbeCacheDir, getSdkSource } from './pi/compat';
import { fuzzyFilterFiles, MAX_MENTION_RESULTS } from './shared/mention';
import {
    buildSelectionPrompt,
    isSelectionTooLarge,
    selectionLineRange,
    MAX_SELECTION_CHARS,
} from './providers/send-to-pi';
import { parseGlobalRules, type GlobalRuleStore } from './pi/approval-memory';
import { createBridge } from './bridge/server';
import type { BridgeContext } from './bridge/types';
import type { DropResolveResult, MentionSymbolItem, ServerMessage } from './shared/protocol';
import { isImagePath, relativeToWorkspace, uriToPath } from './shared/drop-files';

let bridgeContext: BridgeContext | undefined;

const APPROVAL_RULES_KEY = 'pi-agent.approvalRules.global';

// Completion notifications below this many seconds are noise, not signal.
const NOTIFY_MIN_DURATION_SEC = 5;

function formatDurationSec(durationSec: number): string {
    const total = Math.max(1, Math.round(durationSec));
    if (total < 60) return `${total}s`;
    return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** Markdown preamble for the bug-report summary (SDK copy/version first —
 *  that's what a maintainer needs to reproduce). */
function buildDiagnosticMarkdown(manager: TabManager, summary: string): string {
    const session = manager.activeTab?.session;
    const src = getSdkSource();
    const sdkLine = src
        ? `Pi SDK: ${src.source} v${src.version}${src.reason ? ` (bundled fallback: ${src.reason})` : ''}`
        : 'Pi SDK: unknown';
    const model = session?.getCurrentModel();
    const modelLine = model ? `${model.provider}/${model.id}` : 'none';
    const sessionName = session?.getSessionName();
    const sessionPath = session?.getCurrentSessionPath();
    return [
        `# Pi Diagnostic Summary`,
        '',
        `- Generated: ${new Date().toLocaleString()}`,
        `- Model: ${modelLine}`,
        `- Session: ${sessionName ?? 'Untitled'}${sessionPath ? `\`${sessionPath}\`` : ''}`,
        `- ${sdkLine}`,
        '',
        '---',
        '',
        summary,
        '',
    ].join('\n');
}

// ── @-mention workspace glue (AC-FN-21/22) ──

const MENTION_FILE_TTL_MS = 5000;
const MENTION_FILE_SNAPSHOT_LIMIT = 3000;
const MENTION_SEARCH_EXCLUDE = '**/{node_modules,.git}/**';
const MENTION_READ_HARD_CAP = 5 * 1024 * 1024;

let mentionFileSnapshot: { at: number; files: string[] } | null = null;

async function searchWorkspaceFiles(query: string): Promise<string[]> {
    if (!mentionFileSnapshot || Date.now() - mentionFileSnapshot.at > MENTION_FILE_TTL_MS) {
        const uris = await vscode.workspace.findFiles(
            '**/*',
            MENTION_SEARCH_EXCLUDE,
            MENTION_FILE_SNAPSHOT_LIMIT,
        );
        mentionFileSnapshot = {
            at: Date.now(),
            files: uris.map((u) => vscode.workspace.asRelativePath(u).replace(/\\/g, '/')),
        };
    }
    return fuzzyFilterFiles(mentionFileSnapshot.files, query, MAX_MENTION_RESULTS);
}

async function searchWorkspaceSymbols(query: string): Promise<MentionSymbolItem[]> {
    if (!query.trim()) return [];
    try {
        const infos = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            query,
        );
        if (!Array.isArray(infos)) return [];
        return infos.slice(0, 30).map((si) => ({
            name: si.name,
            kind: vscode.SymbolKind[si.kind] ?? 'Symbol',
            path: vscode.workspace.asRelativePath(si.location.uri).replace(/\\/g, '/'),
            line: si.location.range.start.line + 1,
        }));
    } catch {
        return []; // AC-FN-22: no symbol index → file-only degradation.
    }
}

async function resolveMentionPath(relPath: string): Promise<string | null> {
    const folders = vscode.workspace.workspaceFolders;
    const parts = relPath.split('/');
    if (!folders || parts.includes('..')) return null;
    for (const folder of folders) {
        const uri = vscode.Uri.joinPath(folder.uri, ...parts);
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type === vscode.FileType.File) return uri.fsPath;
        } catch {
            // Not in this workspace root — try the next one.
        }
    }
    // Multi-root workspaces: asRelativePath prefixes the root's name
    // ("root-name/src/a.ts"). Strip that first segment and retry against
    // the folder whose name matches.
    if (parts.length > 1) {
        const root = folders.find((f) => f.name === parts[0]);
        if (root) {
            const uri = vscode.Uri.joinPath(root.uri, ...parts.slice(1));
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type === vscode.FileType.File) return uri.fsPath;
            } catch {
                // Root-name prefix guessed wrong — give up.
            }
        }
    }
    return null;
}

async function readMentionFile(fsPath: string): Promise<string | null> {
    try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
        // Hard cap only; the mention module applies the user-facing limit + note.
        return Buffer.from(data.subarray(0, MENTION_READ_HARD_CAP)).toString('utf-8');
    } catch {
        return null;
    }
}

// ── Drag-and-drop file references (AC-FN-21) ──

async function resolveDroppedFiles(uris: string[]): Promise<DropResolveResult[]> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    return Promise.all(
        uris.map(async (uri): Promise<DropResolveResult> => {
            const fsPath = uriToPath(uri);
            if (!fsPath) return { status: 'invalid' };
            const rel = relativeToWorkspace(fsPath, roots);
            // Workspace files: return relative path for @-mention injection.
            if (rel) {
                if (isImagePath(rel)) return { status: 'image' };
                try {
                    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
                    if (stat.type !== vscode.FileType.File) return { status: 'invalid' };
                } catch {
                    return { status: 'invalid' };
                }
                return { status: 'file', path: rel };
            }
            // External files (outside workspace): read content on the host side.
            const uriObj = vscode.Uri.file(fsPath);
            const ext = fsPath.split('.').pop()?.toLowerCase() ?? '';
            const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
            try {
                const stat = await vscode.workspace.fs.stat(uriObj);
                if (stat.type !== vscode.FileType.File) return { status: 'invalid' };
                if (stat.size > 5 * 1024 * 1024) return { status: 'invalid' }; // 5 MB cap
                if (IMAGE_EXTS.has(ext)) {
                    const bytes = await vscode.workspace.fs.readFile(uriObj);
                    const base64 = Buffer.from(bytes).toString('base64');
                    const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png'
                        : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp'
                        : ext === 'bmp' ? 'image/bmp' : 'image/png';
                    return { status: 'external', dataUrl: `data:${mime};base64,${base64}`, name: fsPath.split(/[\\/]/).pop() };
                }
                const bytes = await vscode.workspace.fs.readFile(uriObj);
                const text = new TextDecoder('utf-8').decode(bytes);
                return { status: 'external', content: text, name: fsPath.split(/[\\/]/).pop() };
            } catch {
                return { status: 'invalid' };
            }
        }),
    );
}

export async function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Pi Agent');
    outputChannel.appendLine('Pi Agent extension activating...');

    // Persist the SDK system-probe result under global storage so repeat
    // launches skip `where/which pi` and `npm root -g`.
    setSdkProbeCacheDir(context.globalStorageUri.fsPath);

    try {
        bridgeContext = await createBridge(context);
        process.env.PI_VSCODE_BRIDGE_URL = bridgeContext.url;
        process.env.PI_VSCODE_BRIDGE_TOKEN = bridgeContext.token;
        const bridgeExtensionPath = context.asAbsolutePath('bridge/pi-vscode-bridge.js');
        const secrets = context.secrets;

        let providerRef: SidebarProvider | undefined;
        let tabManagerRef: TabManager | undefined;

        // Global (all-tabs) approval memory rules, persisted in global state.
        const globalRuleStore: GlobalRuleStore = {
            load: () => parseGlobalRules(context.globalState.get<unknown>(APPROVAL_RULES_KEY)),
            save: (rules) => {
                void context.globalState.update(APPROVAL_RULES_KEY, rules);
            },
        };

        // Shared i18n dictionary drives host-side strings too (apply flow).
        setLang(resolveDisplayLang());

        const applyManager = new ApplyManager((tabId, filePath, content) => {
            tabManagerRef?.recordFileSnapshot(tabId, filePath, content);
        });

        const transport = {
            post: (msg: ServerMessage) => providerRef?.post(msg),
            setContext: (key: string, value: unknown) => { void vscode.commands.executeCommand('setContext', key, value); },
        };

        const workspace = {
            openFile: (filePath: string) => {
                const uri = vscode.Uri.file(filePath);
                void vscode.workspace.openTextDocument(uri).then(
                    (doc) => vscode.window.showTextDocument(doc, { preview: true }),
                    () => { /* file may not exist */ },
                );
            },
            getCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
            searchFiles: (query: string) => searchWorkspaceFiles(query),
            searchSymbols: (query: string) => searchWorkspaceSymbols(query),
            resolveMentionPath: (path: string) => resolveMentionPath(path),
            readTextFile: (fsPath: string) => readMentionFile(fsPath),
            resolveDroppedFiles: (uris: string[]) => resolveDroppedFiles(uris),
        };

        const ui = {
            showMessage: (message: string) => void vscode.window.showInformationMessage(message),
            confirmDialog: (message: string) => {
                const yes = t('common.yes');
                return Promise.resolve(
                    vscode.window.showWarningMessage(message, { modal: true }, yes),
                ).then((answer): boolean => answer === yes);
            },
            openSettings: () => void vscode.commands.executeCommand('pi-agent.openSettings'),
            writeClipboard: async (text: string) => {
                await vscode.env.clipboard.writeText(text);
            },
        };

        const agent = {
            applyPreview: (code: string, lang: string, tabId: string) => applyManager.buildPreview(code, lang, tabId),
            applyConfirm: (previewId: string) => applyManager.confirm(previewId),
            applyCancel: (previewId: string) => applyManager.cancel(previewId),
            getCompactionThreshold: () => {
                const raw = Number(
                    vscode.workspace
                        .getConfiguration('pi-agent')
                        .get<number>('contextUsageWarningThreshold', 80),
                );
                return Number.isFinite(raw) ? Math.max(1, Math.min(100, raw)) : 80;
            },
            exportSession: async (content: string, suggestedName: string) => {
                const folder = vscode.workspace.workspaceFolders?.[0];
                const defaultUri = folder
                    ? vscode.Uri.joinPath(folder.uri, suggestedName)
                    : vscode.Uri.file(suggestedName);
                const target = await vscode.window.showSaveDialog({
                    defaultUri,
                    saveLabel: t('export.save'),
                    filters: { Markdown: ['md'] },
                });
                if (!target) return;
                await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
                const open = await vscode.window.showInformationMessage(
                    t('export.success', { path: target.fsPath }),
                    t('export.open'),
                );
                if (open) {
                    void vscode.workspace.openTextDocument(target).then((doc) =>
                        vscode.window.showTextDocument(doc, { preview: true }),
                    );
                }
            },
            notifyAgentDone: (tabName: string, durationSec: number, isTabActive: boolean) => {
                if (!vscode.workspace.getConfiguration('pi-agent').get('notifyOnCompletion', true)) return;
                if (durationSec < NOTIFY_MIN_DURATION_SEC) return;
                if (isTabActive && vscode.window.state.focused) return;
                void vscode.window.showInformationMessage(
                    t('notify.done', { name: tabName, duration: formatDurationSec(durationSec) }),
                );
            },
        };

        const adapters: TabManagerAdapters = { transport, workspace, ui, agent };

        const factory: TabFactory = {
            async create(): Promise<Tab> {
                const session = new PiSessionManager(outputChannel, bridgeExtensionPath, secrets);
                await session.initialize();
                const checkpointManager = new CheckpointManager();
                const diffManager = new DiffManager(session, checkpointManager);
                return { id: '', name: 'New Agent', session, diffManager, checkpointManager };
            },
        };

        const lockDeps = createNodeLockDeps(
            path.join(context.globalStorageUri.fsPath, 'locks'),
        );
        const tabManager = new TabManager(factory, adapters, globalRuleStore, lockDeps);
        tabManagerRef = tabManager;
        // T16: SDK loading + session creation run off the activation critical
        // path; consumers (webview, commands) await initialize() themselves.
        void tabManager.initialize().catch((err: any) => {
            outputChannel.appendLine(`[pi-vscode] initialization failed: ${err?.message ?? err}`);
        });

        const diffContentProvider = new DiffContentProvider();
        const statusBar = new StatusBarManager(tabManager);

        const inlineChat = new InlineChatManager({
            getTabManager: () => tabManagerRef,
            showMessage: (message) => void vscode.window.showInformationMessage(message),
            confirmDialog: (message) => {
                const yes = t('common.yes');
                return Promise.resolve(
                    vscode.window.showWarningMessage(message, { modal: true }, yes),
                ).then((answer): boolean => answer === yes);
            },
            setContext: (key, value) =>
                void vscode.commands.executeCommand('setContext', key, value),
        });

        const selectionTracker = new SelectionContextTracker(
            (msg) => providerRef?.post(msg),
            (message) => void vscode.window.showInformationMessage(message),
        );

        const sidebarProvider = new SidebarProvider(context.extensionUri, tabManager, selectionTracker);
        providerRef = sidebarProvider;

        const commitMessage = new CommitMessageManager({
            getGitApi: (): CommitGitApi | undefined => {
                const git = vscode.extensions.getExtension<{ getAPI?: (version: 1) => unknown }>('vscode.git');
                if (!git?.isActive) return undefined;
                return (git.exports?.getAPI?.(1) as CommitGitApi | undefined) ?? undefined;
            },
            // The active tab's model follows what the user picked in the UI.
            getSessionModel: async () => tabManagerRef?.activeTab?.session.session?.model,
            getConfiguredModel: async () => {
                const cfg = vscode.workspace.getConfiguration('pi-agent');
                const provider = cfg.get<string>('apiProvider', '');
                const modelId = cfg.get<string>('defaultModel', '');
                if (!modelId) return undefined;
                // Same availability-checked resolution new sessions use.
                const registry = await getModelRegistry();
                return findConfiguredModel(registry, provider, modelId);
            },
            getFallbackModel: async () => {
                const runtime = await getModelRuntime();
                return runtime.getAvailableSnapshot()[0];
            },
            complete: async (model, context, options) => {
                const runtime = await getModelRuntime();
                return runtime.completeSimple(model as any, context as any, options as any);
            },
            showMessage: (message) => void vscode.window.showErrorMessage(message),
        });

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('pi-agent.chat', sidebarProvider),
            vscode.workspace.registerTextDocumentContentProvider('pi-diff', diffContentProvider),
            tabManager,
            statusBar,
            inlineChat,
            selectionTracker,

            vscode.commands.registerCommand('pi-agent.inlineChat', () => {
                void inlineChat.start();
            }),

            vscode.commands.registerCommand('pi-agent.inlineAccept', () => {
                inlineChat.accept();
            }),

            vscode.commands.registerCommand('pi-agent.inlineDiscard', () => {
                void inlineChat.discard();
            }),

            vscode.commands.registerCommand('pi-agent.newChat', async () => {
                await sidebarProvider.newSession();
            }),

            vscode.commands.registerCommand('pi-agent.abort', async () => {
                await sidebarProvider.abort();
            }),

            vscode.commands.registerCommand('pi-agent.selectModel', async () => {
                await sidebarProvider.selectModel();
            }),

            vscode.commands.registerCommand('pi-agent.toggleThinking', async () => {
                const level = await sidebarProvider.toggleThinking();
                if (level) {
                    vscode.window.showInformationMessage(
                        t('command.thinkingChanged', { level: thinkingLevelLabel(level) }),
                    );
                }
            }),

            vscode.commands.registerCommand('pi-agent.compact', async () => {
                await sidebarProvider.compact();
                vscode.window.showInformationMessage(t('compact.done'));
            }),

            vscode.commands.registerCommand('pi-agent.sendToPi', async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor || editor.selection.isEmpty) {
                    vscode.window.showInformationMessage(t('sendToPi.noSelection'));
                    return;
                }
                const selection = editor.selection;
                const code = editor.document.getText(selection);
                if (code.trim().length === 0) {
                    vscode.window.showInformationMessage(t('sendToPi.noSelection'));
                    return;
                }
                if (isSelectionTooLarge(code)) {
                    vscode.window.showWarningMessage(
                        t('sendToPi.tooLarge', { n: MAX_SELECTION_CHARS }),
                    );
                    return;
                }
                const { start, end } = selectionLineRange(
                    selection.start.line,
                    selection.end.line,
                    selection.end.character,
                );
                const promptText = buildSelectionPrompt({
                    // Untitled / out-of-workspace documents fall back to their
                    // label or absolute path — a stable label, not a resolvable one.
                    displayPath: vscode.workspace.asRelativePath(editor.document.uri),
                    startLine: start,
                    endLine: end,
                    languageId: editor.document.languageId,
                    code,
                });
                // Reveal the panel first so the turn lands in a visible surface.
                void vscode.commands.executeCommand('pi-agent.chat.focus');
                try {
                    await tabManagerRef?.sendToPi(promptText);
                } catch (err) {
                    const text = humanizeErrorMessage(err);
                    if (text) vscode.window.showErrorMessage(text);
                }
            }),

            vscode.commands.registerCommand('pi-agent.focusChat', () => {
                vscode.commands.executeCommand('pi-agent.chat.focus');
            }),

            vscode.commands.registerCommand('pi-agent.generateCommitMessage', (target?: unknown) => {
                void commitMessage.generateIntoInputBox(target);
            }),

            vscode.commands.registerCommand('pi-agent.generateDiagnosticSummary', async () => {
                const manager = tabManagerRef;
                if (!manager) return;
                if (manager.activeTab && manager.isTabStreaming(manager.activeTab.id)) {
                    vscode.window.showWarningMessage(t('diagnostic.busy'));
                    return;
                }
                const controller = new AbortController();
                let summary: string | undefined;
                try {
                    summary = await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: t('diagnostic.generating'),
                            cancellable: true,
                        },
                        (_progress, token) => {
                            token.onCancellationRequested(() => controller.abort());
                            return manager.generateDiagnosticSummary({ signal: controller.signal });
                        },
                    );
                } catch (err: any) {
                    if (controller.signal.aborted || err?.name === 'AbortError') {
                        vscode.window.showInformationMessage(t('diagnostic.cancelled'));
                    } else {
                        const text = humanizeErrorMessage(err) ?? err?.message ?? String(err);
                        vscode.window.showErrorMessage(t('diagnostic.failed', { message: text }));
                    }
                    return;
                }
                if (!summary || !summary.trim()) {
                    vscode.window.showInformationMessage(t('diagnostic.empty'));
                    return;
                }
                const doc = await vscode.workspace.openTextDocument({
                    content: buildDiagnosticMarkdown(manager, summary),
                    language: 'markdown',
                });
                await vscode.window.showTextDocument(doc, { preview: true });
            }),

            vscode.commands.registerCommand('pi-agent.openSettings', () => {
                SettingsPanel.show(
                    context.extensionUri,
                    secrets,
                    globalRuleStore,
                    async (provider, key) => {
                        const runtime = await getModelRuntime();
                        if (key) {
                            await runtime.setRuntimeApiKey(provider, key);
                        } else {
                            await runtime.removeRuntimeApiKey(provider);
                        }
                    },
                );
            }),

            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('pi-agent.displayLanguage')) {
                    const lang = resolveDisplayLang();
                    setLang(lang);
                    sidebarProvider.post({ type: 'langChanged', lang });
                    SettingsPanel.notifyLanguage(lang);
                    statusBar.refresh();
                }
                if (e.affectsConfiguration('pi-agent.cacheWarming')) {
                    // Only an explicitly-set value may override Pi's native
                    // mode (the SDK default or a CLI-set one survives resets).
                    const inspected = vscode.workspace
                        .getConfiguration('pi-agent')
                        .inspect<string>('cacheWarming');
                    if (
                        inspected?.globalValue !== undefined ||
                        inspected?.workspaceValue !== undefined ||
                        inspected?.workspaceFolderValue !== undefined
                    ) {
                        const mode = vscode.workspace
                            .getConfiguration('pi-agent')
                            .get<string>('cacheWarming', 'streaming');
                        tabManagerRef?.setCacheWarmingMode(mode);
                    }
                }
            }),
        );

        outputChannel.appendLine('Pi Agent extension activated.');
    } catch (err: any) {
        outputChannel.appendLine(`Failed to activate: ${err.message}`);
        vscode.window.showErrorMessage(`Pi Agent failed to activate: ${err.message}`);
    }
}

export async function deactivate() {
    await PiSessionManager.disposeGlobal();
    await bridgeContext?.dispose();
    bridgeContext = undefined;
}
