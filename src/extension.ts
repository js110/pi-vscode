import * as vscode from 'vscode';
import { PiSessionManager } from './pi/session';
import { SidebarProvider } from './providers/sidebar';
import { StatusBarManager } from './providers/status-bar';
import { SettingsPanel } from './providers/settings-panel';

import { DiffManager, DiffContentProvider } from './providers/diff';
import { CheckpointManager } from './providers/checkpoint';
import { createBridge } from './bridge/server';
import type { BridgeContext } from './bridge/types';

let piSession: PiSessionManager | undefined;
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

        piSession = new PiSessionManager(outputChannel, bridgeExtensionPath, context.secrets);
        await piSession.initialize();

        const diffContentProvider = new DiffContentProvider();
        const checkpointManager = new CheckpointManager();
        const statusBar = new StatusBarManager(piSession);

        const diffManager = new DiffManager(piSession, checkpointManager);
        const sidebarProvider = new SidebarProvider(
            context.extensionUri,
            piSession,
            diffManager,
            checkpointManager,
            outputChannel,
            bridgeExtensionPath,
            context.secrets,
        );

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('pi-agent.chat', sidebarProvider),
            vscode.workspace.registerTextDocumentContentProvider('pi-diff', diffContentProvider),
            statusBar,

            diffManager,
            checkpointManager,
            outputChannel,

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
                    context.secrets,
                    async (provider, key) => piSession?.setRuntimeApiKey(provider, key),
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
    await piSession?.dispose();
    await PiSessionManager.disposeGlobal();
    await bridgeContext?.dispose();
    bridgeContext = undefined;
}
