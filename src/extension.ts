import * as vscode from 'vscode';
import { PiSessionManager } from './pi/session';
import { SidebarProvider } from './providers/sidebar';
import { TabManager, type Tab, type TabFactory, type TabManagerHooks } from './providers/tab';
import { StatusBarManager } from './providers/status-bar';
import { SettingsPanel } from './providers/settings-panel';

import { DiffManager, DiffContentProvider } from './providers/diff';
import { CheckpointManager } from './providers/checkpoint';
import { getModelRuntime } from './pi/auth';
import { createBridge } from './bridge/server';
import type { BridgeContext } from './bridge/types';
import type { ServerMessage } from './shared/protocol';

let bridgeContext: BridgeContext | undefined;

const SIDEBAR_PLACEMENT_KEY = 'pi-agent.sidebarPlacementDone';

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

        const tabManager = new TabManager(factory, hooks);
        await tabManager.initialize();

        const diffContentProvider = new DiffContentProvider();
        const statusBar = new StatusBarManager(tabManager);

        const sidebarProvider = new SidebarProvider(context.extensionUri, tabManager);
        providerRef = sidebarProvider;

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('pi-agent.chat', sidebarProvider),
            vscode.workspace.registerTextDocumentContentProvider('pi-diff', diffContentProvider),
            statusBar,

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

            vscode.commands.registerCommand('pi-agent.focusChat', () => {
                vscode.commands.executeCommand('pi-agent.chat.focus');
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
