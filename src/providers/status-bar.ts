import * as vscode from 'vscode';
import type { TabManager } from './tab';
import { formatTokensCompact } from '../shared/webview-text';

export class StatusBarManager implements vscode.Disposable {
    private _item: vscode.StatusBarItem;
    private _tabManager: TabManager;
    private _unsubscribe: (() => void) | undefined;

    constructor(tabManager: TabManager) {
        this._tabManager = tabManager;
        this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this._item.command = 'pi-agent.selectModel';
        this._update();
        this._item.show();

        this._unsubscribe = tabManager.onStateChange(() => this._update());
    }

    private _update(): void {
        const tab = this._tabManager.activeTab;
        const session = tab?.session;
        if (!session) return;

        const model = session.getCurrentModel();
        const isStreaming = this._tabManager.isStreaming;
        const icon = isStreaming ? '$(loading~spin)' : '$(hubot)';
        const name = model ? (model.name ?? model.id) : 'No model';
        this._item.text = `${icon} Pi: ${name}`;

        const parts: string[] = ['Pi Agent'];
        if (model?.name) {
            parts.push(`Model: ${model.provider}/${model.id}`);
        }

        const stats = session.getSessionStats();
        const tokens = stats?.tokens;
        if (tokens) {
            if (tokens.input) parts.push(`↑${formatTokensCompact(tokens.input)}`);
            if (tokens.output) parts.push(`↓${formatTokensCompact(tokens.output)}`);
            if (tokens.cacheRead) parts.push(`R${formatTokensCompact(tokens.cacheRead)}`);
            if (tokens.cacheWrite) parts.push(`W${formatTokensCompact(tokens.cacheWrite)}`);
            const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
            if ((tokens.cacheRead > 0 || tokens.cacheWrite > 0) && prompt > 0) {
                parts.push(`CH${((tokens.cacheRead / prompt) * 100).toFixed(1)}%`);
            }
            if (typeof stats?.cost === 'number' && stats.cost > 0) {
                parts.push(`$${stats.cost.toFixed(3)}`);
            }
        }

        const usage = session.getContextUsage();
        if (usage) {
            const windowStr = formatTokensCompact(usage.contextWindow);
            const display = usage.tokens !== null || usage.percent !== null
                ? `${Math.round(usage.percent ?? 0)}%/${windowStr}`
                : `?/${windowStr}`;
            parts.push(`Context: ${display}`);
        }

        const thinking = session.getThinkingLevel();
        if (thinking) {
            parts.push(`Thinking: ${thinking}`);
        }
        this._item.tooltip = parts.join('  ');
    }

    dispose(): void {
        this._unsubscribe?.();
        this._item.dispose();
    }
}
