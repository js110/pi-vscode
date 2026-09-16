import * as vscode from 'vscode';
import * as path from 'path';
import { PiSessionManager } from './pi/session';
import { SidebarProvider } from './providers/sidebar';
import { TabManager, type Tab, type TabFactory, type TabManagerHooks } from './providers/tab';
import { StatusBarManager } from './providers/status-bar';
import { SettingsPanel } from './providers/settings-panel';
import { resolveDisplayLang } from './providers/lang';

import { DiffManager, DiffContentProvider } from './providers/diff';
import { CheckpointManager } from './providers/checkpoint';
import { ApplyManager } from './providers/apply';
import { TerminalCapture } from './providers/terminal-capture';
import type { TerminalQuoteResult } from './shared/terminal-quote';
import { InlineChatManager } from './providers/inline-chat';
import { CommitMessageManager, type CommitGitApi } from './providers/commit-message';
import { createNodeLockDeps } from './pi/session-lock';
import { getModelRuntime } from './pi/auth';
import { getModelRegistry, findConfiguredModel } from './pi/models';
import { setLang, t } from './shared/i18n';
import { fuzzyFilterFiles, MAX_MENTION_RESULTS } from './shared/mention';
import {
    buildSelectionPrompt,
    isSelectionTooLarge,
    selectionLineRange,
    MAX_SELECTION_CHARS,
} from './providers/send-to-pi';
import type { GlobalRuleStore } from './pi/approval-memory';
import { createBridge } from './bridge/server';
import type { BridgeContext } from './bridge/types';
import type { ApprovalRuleInfo, DropResolveResult, MentionSymbolItem, ServerMessage } from './shared/protocol';
import { isImagePath, relativeToWorkspace, uriToPath } from './shared/drop-files';

let bridgeContext: BridgeContext | undefined;

const SIDEBAR_PLACEMENT_KEY = 'pi-agent.sidebarPlacementDone';
const APPROVAL_RULES_KEY = 'pi-agent.approvalRules.global';

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
            if (!rel) return { status: 'invalid' };
            // Images ride the image-attach path, not the reference path.
            if (isImagePath(rel)) return { status: 'image' };
            try {
                const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
                if (stat.type !== vscode.FileType.File) return { status: 'invalid' };
            } catch {
                return { status: 'invalid' };
            }
            return { status: 'file', path: rel };
        }),
    );
}

/**
 * Move the Pi panel view between workbench areas. The view must be focused
 * for VS Code's move commands to pick it up, so we focus its container first.
 */
async function moveSidebarView(
    target: 'secondary' | 'primary',
    outputChannel: vscode.OutputChannel,
): Promise<void> {
    try {
        await vscode.commands.executeCommand('workbench.view.extension.pi-agent');
        // Give the view a moment to receive focus before it is moved.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await vscode.commands.executeCommand(
            target === 'secondary'
                ? 'workbench.action.moveViewToSecondarySideBar'
                : 'workbench.action.moveViewToPrimarySideBar',
        );
        outputChannel.appendLine(`Pi panel moved to ${target} sidebar.`);
    } catch (err: any) {
        outputChannel.appendLine(`Failed to move Pi panel to ${target} sidebar: ${err?.message ?? err}`);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Pi Agent');
    outputChannel.appendLine('Pi Agent extension activating...');

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
            load: () => {
                const raw = context.globalState.get<unknown>(APPROVAL_RULES_KEY);
                if (!Array.isArray(raw)) return [];
                return raw.filter(
                    (r): r is ApprovalRuleInfo =>
                        !!r && typeof r === 'object'
                        && typeof (r as ApprovalRuleInfo).tool === 'string'
                        && (r as ApprovalRuleInfo).tool.length > 0
                        && typeof (r as ApprovalRuleInfo).createdAt === 'number',
                );
            },
            save: (rules) => {
                void context.globalState.update(APPROVAL_RULES_KEY, rules);
            },
        };

        // Shared i18n dictionary drives host-side strings too (apply flow).
        setLang(resolveDisplayLang());

        const applyManager = new ApplyManager((tabId, filePath, content) => {
            tabManagerRef?.recordFileSnapshot(tabId, filePath, content);
        });

        const terminalCapture = new TerminalCapture();

        const hooks: TabManagerHooks = {
            post: (msg) => providerRef?.post(msg),
            setContext: (key, value) => { void vscode.commands.executeCommand('setContext', key, value); },
            openFile: (filePath) => {
                const uri = vscode.Uri.file(filePath);
                void vscode.workspace.openTextDocument(uri).then(
                    (doc) => vscode.window.showTextDocument(doc, { preview: true }),
                    () => { /* file may not exist */ },
                );
            },
            showMessage: (message) => void vscode.window.showInformationMessage(message),
            confirmDialog: (message) =>
                Promise.resolve(
                    vscode.window.showWarningMessage(message, { modal: true }, 'Yes'),
                ).then((answer): boolean => answer === 'Yes'),
            openSettings: () => void vscode.commands.executeCommand('pi-agent.openSettings'),
            getCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
            applyPreview: (code, lang, tabId) => applyManager.buildPreview(code, lang, tabId),
            applyConfirm: (previewId) => applyManager.confirm(previewId),
            applyCancel: (previewId) => applyManager.cancel(previewId),
            getCompactionThreshold: () => {
                const raw = Number(
                    vscode.workspace
                        .getConfiguration('pi-agent')
                        .get<number>('contextUsageWarningThreshold', 80),
                );
                return Number.isFinite(raw) ? Math.max(1, Math.min(100, raw)) : 80;
            },
            searchFiles: (query) => searchWorkspaceFiles(query),
            searchSymbols: (query) => searchWorkspaceSymbols(query),
            resolveMentionPath: (path) => resolveMentionPath(path),
            readTextFile: (fsPath) => readMentionFile(fsPath),
            resolveDroppedFiles: (uris) => resolveDroppedFiles(uris),
            quoteTerminal: async (): Promise<TerminalQuoteResult> => {
                const terminal = vscode.window.activeTerminal;
                if (terminal) {
                    const entry = terminalCapture.getLatest(terminal);
                    if (entry) return { ok: true, entry };
                    return terminal.shellIntegration
                        ? { ok: false, reason: 'noOutput' }
                        : { ok: false, reason: 'noShellIntegration' };
                }
                const anyEntry = terminalCapture.getLatest();
                return anyEntry ? { ok: true, entry: anyEntry } : { ok: false, reason: 'noTerminal' };
            },
        };

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
        const tabManager = new TabManager(factory, hooks, globalRuleStore, lockDeps);
        tabManagerRef = tabManager;
        await tabManager.initialize();

        const diffContentProvider = new DiffContentProvider();
        const statusBar = new StatusBarManager(tabManager);

        const inlineChat = new InlineChatManager({
            getTabManager: () => tabManagerRef,
            showMessage: (message) => void vscode.window.showInformationMessage(message),
            confirmDialog: (message) =>
                Promise.resolve(
                    vscode.window.showWarningMessage(message, { modal: true }, 'Yes'),
                ).then((answer): boolean => answer === 'Yes'),
            setContext: (key, value) =>
                void vscode.commands.executeCommand('setContext', key, value),
        });

        const sidebarProvider = new SidebarProvider(context.extensionUri, tabManager);
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
            terminalCapture,

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
                const level = sidebarProvider.toggleThinking();
                if (level) {
                    vscode.window.showInformationMessage(`Thinking level: ${level}`);
                }
            }),

            vscode.commands.registerCommand('pi-agent.compact', async () => {
                await sidebarProvider.compact();
                vscode.window.showInformationMessage('Pi context compacted.');
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
                } catch (err: any) {
                    vscode.window.showErrorMessage(err?.message ?? String(err));
                }
            }),

            vscode.commands.registerCommand('pi-agent.focusChat', () => {
                vscode.commands.executeCommand('pi-agent.chat.focus');
            }),

            vscode.commands.registerCommand('pi-agent.generateCommitMessage', (target?: unknown) => {
                void commitMessage.generateIntoInputBox(target);
            }),

            vscode.commands.registerCommand('pi-agent.moveToSecondarySidebar', () => {
                void moveSidebarView('secondary', outputChannel);
            }),

            vscode.commands.registerCommand('pi-agent.moveToPrimarySidebar', () => {
                void moveSidebarView('primary', outputChannel);
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
                }
            }),
        );

        outputChannel.appendLine('Pi Agent extension activated.');

        // First run only: default the panel to the secondary (right) sidebar.
        // Afterwards the user's own placement is respected.
        const placementDone = context.globalState.get<boolean>(SIDEBAR_PLACEMENT_KEY);
        if (!placementDone) {
            await context.globalState.update(SIDEBAR_PLACEMENT_KEY, true);
            await moveSidebarView('secondary', outputChannel);
        }
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
