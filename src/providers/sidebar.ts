import * as vscode from 'vscode';
import type { ClientMessage, ServerMessage, SelectionContextInfo } from '../shared/protocol';
import { TabManager } from './tab';
import { SelectionContextTracker } from './selection-context';
import { resolveDisplayLang } from './lang';
import { t } from '../shared/i18n';
import { humanizeErrorMessage } from '../shared/error-copy';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _tabManager: TabManager;

    constructor(
        extensionUri: vscode.Uri,
        tabManager: TabManager,
        private _selectionTracker?: SelectionContextTracker,
    ) {
        this._extensionUri = extensionUri;
        this._tabManager = tabManager;
        tabManager.onStateChange(() => {
            const { state, images } = this._tabManager.getSnapshot();
            this.post({ type: 'stateSync', state, images });
        });
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

        // VS Code destroys the webview whenever the view is hidden, but the
        // TabManager (and its live sessions) must survive hide/show cycles —
        // it is disposed with the extension via context.subscriptions.

        this.post({ type: 'ready' });
        this.post({ type: 'langChanged', lang: resolveDisplayLang() });
        // The view may have been hidden while a selection chip was showing.
        this.post({
            type: 'selectionChanged',
            selection: this._selectionTracker?.current ?? null,
        });
        // SDK loading runs off the activation path; the panel shows the empty
        // state immediately and gets the real state once the first tab exists.
        this.post({ type: 'stateSync', state: this._tabManager.getState() });
        void this._tabManager.initialize().then(() => {
            if (this._view !== webviewView) return;
            const { state, images } = this._tabManager.getSnapshot(true);
            this.post({ type: 'stateSync', state, images });
            void this._tabManager.postConfigSnapshot();
        }, (err: unknown) => {
            if (this._view !== webviewView) return;
            const message = err instanceof Error ? err.message : String(err);
            this.post({ type: 'error', message: t('init.failed', { message }) });
        });
    }

    post(message: ServerMessage): void {
        this._view?.webview.postMessage(message);
    }

    private async _handleMessage(msg: ClientMessage): Promise<void> {
        try {
            if (msg.type === 'dismissSelection') {
                this._selectionTracker?.dismiss();
                return;
            }
            // Copilot-style auto-attach: a plain text prompt rides the active
            // selection (one-shot). Explicit @-mentions opt out — they already
            // carry their own file context.
            const mentions = msg.type === 'prompt' ? msg.mentions : undefined;
            let wrapped: string | null = null;
            let priorSelection: SelectionContextInfo | null = null;
            if (
                (msg.type === 'prompt' || msg.type === 'queueMessage')
                && !mentions
                && this._selectionTracker
            ) {
                priorSelection = this._selectionTracker.current;
                wrapped = this._selectionTracker.consumePrompt(msg.text);
                if (wrapped !== null) {
                    msg = { ...msg, text: wrapped } as typeof msg;
                }
            }
            try {
                await this._tabManager.dispatch(msg);
            } catch (err: unknown) {
                // The turn never started — give the chip back so the user can
                // retry without re-selecting.
                if (wrapped !== null) this._selectionTracker?.reinstate(priorSelection);
                throw err;
            }
        } catch (err: unknown) {
            // Raw detail goes to the host console for diagnosis; the panel
            // only ever sees humanized copy (T17).
            console.error('[pi-vscode] dispatch failed:', err);
            const text = humanizeErrorMessage(err);
            if (text) this.post({ type: 'error', message: text });
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

    async toggleThinking(): Promise<string | undefined> {
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
        const nonce = getNonce();
        const lang = resolveDisplayLang();

        return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>Pi Agent</title>
</head>
<body>
    <div id="app"></div>
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
