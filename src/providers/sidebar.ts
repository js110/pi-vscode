import * as vscode from 'vscode';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { TabManager } from './tab';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _tabManager: TabManager;

    constructor(
        extensionUri: vscode.Uri,
        tabManager: TabManager,
    ) {
        this._extensionUri = extensionUri;
        this._tabManager = tabManager;
        tabManager.onStateChange(() => this.post({ type: 'stateSync', state: this._tabManager.getState() }));
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((msg: ClientMessage) => {
            this._handleMessage(msg);
        });

        webviewView.onDidDispose(() => {
            this._tabManager.dispose();
        });

        this.post({ type: 'ready' });
        this.post({ type: 'stateSync', state: this._tabManager.getState() });
    }

    post(message: ServerMessage): void {
        this._view?.webview.postMessage(message);
    }

    private async _handleMessage(msg: ClientMessage): Promise<void> {
        try {
            await this._tabManager.dispatch(msg);
        } catch (err: any) {
            this.post({ type: 'error', message: err.message ?? String(err) });
        }
    }

    async newSession(): Promise<void> {
        await this._tabManager.newSession();
    }

    async abort(): Promise<void> {
        await this._tabManager.abort();
    }

    async selectModel(): Promise<void> {
        await this._tabManager.selectModel();
    }

    toggleThinking(): string | undefined {
        return this._tabManager.toggleThinking();
    }

    async compact(): Promise<void> {
        await this._tabManager.compact();
    }

    private _getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'main.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'styles', 'main.css')
        );
        const iconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'icons')
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>Pi Agent</title>
</head>
<body>
    <div id="app" data-icons-uri="${iconsUri}"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
