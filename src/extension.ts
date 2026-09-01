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

            vscode.commands.registerCommand('pi-agent.openSettings', () => {
                SettingsPanel.show(
                    context.extensionUri,
                    context.secrets,
                    async (provider, key) => piSession?.setRuntimeApiKey(provider, key),
                );
            }),
        );

        outputChannel.appendLine('Pi Agent extension activated.');
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
