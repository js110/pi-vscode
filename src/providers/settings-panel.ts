import * as vscode from 'vscode';
import type { SettingsClientMessage, SettingsServerMessage, SettingsData, Lang } from '../shared/protocol';
import { API_KEY_PREFIX } from '../shared/protocol';
import type { GlobalRuleStore } from '../pi/approval-memory';
import { discoverSkills, resolveAgentDir } from '../pi/skills';
import { resolveDisplayLang } from './lang';
import { humanizeErrorMessage } from '../shared/error-copy';
import { effectiveSkin } from '../shared/skins';
import { customSkinPathSync, saveCustomSkin, clearCustomSkin } from '../utils/custom-skin';
import { avatarInfoSync, saveAvatar, clearAvatar, type AvatarSlot } from '../utils/custom-avatar';
import { t } from '../shared/i18n';

export class SettingsPanel {
    private static _instance: SettingsPanel | undefined;
    private _panel: vscode.WebviewPanel;
    private _extensionUri: vscode.Uri;
    private _secrets: vscode.SecretStorage;
    private _globalRules: GlobalRuleStore;
    private _disposables: vscode.Disposable[] = [];
    private _onCredentialChange?: (provider: string, key?: string) => Promise<void>;
    /** globalStorage subdir for the uploaded custom-skin image. */
    private _storageDir?: string;
    /** Notified after any custom-skin file change (upload/clear), even when
     *  the `pi-agent.skin` config value itself doesn't change. */
    private _onSkinChange?: () => void;
    /** globalStorage subdir for the uploaded avatar images (pi + user). */
    private _avatarStorageDir?: string;
    /** Notified after any avatar file change (upload/clear). */
    private _onAvatarsChange?: () => void;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        secrets: vscode.SecretStorage,
        globalRules: GlobalRuleStore,
        onCredentialChange?: (provider: string, key?: string) => Promise<void>,
        storageDir?: string,
        onSkinChange?: () => void,
        avatarStorageDir?: string,
        onAvatarsChange?: () => void,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._secrets = secrets;
        this._globalRules = globalRules;
        this._onCredentialChange = onCredentialChange;
        this._storageDir = storageDir;
        this._onSkinChange = onSkinChange;
        this._avatarStorageDir = avatarStorageDir;
        this._onAvatarsChange = onAvatarsChange;

        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                extensionUri,
                ...(this._storageDir ? [vscode.Uri.file(this._storageDir)] : []),
                ...(this._avatarStorageDir ? [vscode.Uri.file(this._avatarStorageDir)] : []),
            ],
        };
        this._panel.webview.html = this._getHtml();

        this._panel.webview.onDidReceiveMessage(
            (msg: SettingsClientMessage) => this._handleMessage(msg),
            undefined,
            this._disposables,
        );

        this._panel.onDidDispose(() => this._dispose(), undefined, this._disposables);

        const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('pi-agent')) {
                this._sendSettings();
            }
        });
        this._disposables.push(configListener);
    }

    /** Push a language change to the open settings webview, if any. */
    static notifyLanguage(lang: Lang): void {
        SettingsPanel._instance?._post({ type: 'langChanged', lang });
    }

    static show(
        extensionUri: vscode.Uri,
        secrets: vscode.SecretStorage,
        globalRules: GlobalRuleStore,
        onCredentialChange?: (provider: string, key?: string) => Promise<void>,
        storageDir?: string,
        onSkinChange?: () => void,
        avatarStorageDir?: string,
        onAvatarsChange?: () => void,
    ): void {
        if (SettingsPanel._instance) {
            SettingsPanel._instance._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'pi-agent.settings',
            'Pi Agent Settings',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            },
        );

        SettingsPanel._instance = new SettingsPanel(
            panel, extensionUri, secrets, globalRules, onCredentialChange, storageDir, onSkinChange,
            avatarStorageDir, onAvatarsChange,
        );
    }

    private async _handleMessage(msg: SettingsClientMessage): Promise<void> {
        try {
            switch (msg.type) {
                case 'getSettings':
                    await this._sendSettings();
                    this._post({ type: 'langChanged', lang: resolveDisplayLang() });
                    break;
                case 'updateSetting':
                    await this._updateSetting(msg.key, msg.value);
                    break;
                case 'setCustomSkin': {
                    if (!this._storageDir) {
                        this._post({ type: 'error', message: t('settings.skin.unavailable') });
                        break;
                    }
                    const picks = await vscode.window.showOpenDialog({
                        canSelectMany: false,
                        title: t('settings.skin.dialogTitle'),
                        filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
                    });
                    if (!picks?.[0]) break;
                    await saveCustomSkin(this._storageDir, picks[0].fsPath);
                    await vscode.workspace.getConfiguration('pi-agent')
                        .update('skin', 'custom', vscode.ConfigurationTarget.Global);
                    await this._sendSettings();
                    this._onSkinChange?.();
                    break;
                }
                case 'clearCustomSkin':
                    if (this._storageDir) await clearCustomSkin(this._storageDir);
                    await vscode.workspace.getConfiguration('pi-agent')
                        .update('skin', 'default', vscode.ConfigurationTarget.Global);
                    await this._sendSettings();
                    this._onSkinChange?.();
                    break;
                case 'setPiAvatar':
                    await this._setAvatar('pi');
                    break;
                case 'setUserAvatar':
                    await this._setAvatar('user');
                    break;
                case 'clearPiAvatar':
                    await this._clearAvatar('pi');
                    break;
                case 'clearUserAvatar':
                    await this._clearAvatar('user');
                    break;
                case 'setApiKey':
                    await this._secrets.store(`${API_KEY_PREFIX}${msg.provider}`, msg.key);
                    await this._onCredentialChange?.(msg.provider, msg.key);
                    await this._sendSettings();
                    break;
                case 'clearApiKey':
                    await this._secrets.delete(`${API_KEY_PREFIX}${msg.provider}`);
                    await this._onCredentialChange?.(msg.provider);
                    await this._sendSettings();
                    break;
                case 'getSkills':
                    await this._sendSkills();
                    break;
                case 'getApprovalRules':
                    this._post({ type: 'approvalRules', rules: this._globalRules.load() });
                    break;
                case 'revokeApprovalRule':
                    this._globalRules.save(
                        this._globalRules.load().filter((r) => r.tool !== msg.tool),
                    );
                    this._post({ type: 'approvalRules', rules: this._globalRules.load() });
                    break;
                case 'clearApprovalRules':
                    this._globalRules.save([]);
                    this._post({ type: 'approvalRules', rules: [] });
                    break;
            }
        } catch (err: unknown) {
            console.error('[pi-vscode] settings message failed:', err);
            const text = humanizeErrorMessage(err);
            if (text) this._post({ type: 'error', message: text });
        }
    }

    private async _updateSetting(key: string, value: any): Promise<void> {
        const config = vscode.workspace.getConfiguration('pi-agent');
        await config.update(key, value, vscode.ConfigurationTarget.Global);
    }

    private async _sendSettings(): Promise<void> {
        const config = vscode.workspace.getConfiguration('pi-agent');
        const provider = config.get<string>('apiProvider', '');

        let apiKeySet = false;
        if (provider) {
            const stored = await this._secrets.get(`${API_KEY_PREFIX}${provider}`);
            apiKeySet = !!stored;
        }

        const authMethod = this._detectAuthMethod(provider, apiKeySet);
        const customPath = this._storageDir ? customSkinPathSync(this._storageDir) : undefined;
        const piAvatar = this._avatarStorageDir ? avatarInfoSync(this._avatarStorageDir, 'pi') : undefined;
        const userAvatar = this._avatarStorageDir ? avatarInfoSync(this._avatarStorageDir, 'user') : undefined;

        const data: SettingsData = {
            apiProvider: provider,
            apiKeySet,
            authMethod,
            defaultModel: config.get<string>('defaultModel', ''),
            thinkingLevel: config.get<string>('thinkingLevel', 'off'),
            autoApproveTools: config.get<boolean>('autoApproveTools', false),
            allowedTools: config.get<string[]>('allowedTools', []),
            excludeTools: config.get<string[]>('excludeTools', []),
            enableCodemode: config.get<boolean>('enableCodemode', false),
            enableToolSearch: config.get<boolean>('enableToolSearch', false),
            autoSaveSessions: config.get<boolean>('autoSaveSessions', true),
            sessionStoragePath: config.get<string>('sessionStoragePath', ''),
            contextUsageWarningThreshold: config.get<number>('contextUsageWarningThreshold', 80),
            fontSize: config.get<number>('fontSize', 13),
            skin: effectiveSkin(config.get<string>('skin', 'default'), !!customPath),
            // Preview whenever an image exists, even if it isn't the active
            // skin — so the user can switch back to it.
            customSkinUrl: customPath
                ? this._panel.webview.asWebviewUri(vscode.Uri.file(customPath)).toString()
                : undefined,
            customSkinOpacity: config.get<number>('customSkinOpacity', 40),
            cacheWarming: config.get<string>('cacheWarming', 'streaming'),
            piAvatarUrl: piAvatar
                ? this._avatarUrl(piAvatar)
                : undefined,
            userAvatarUrl: userAvatar
                ? this._avatarUrl(userAvatar)
                : undefined,
        };

        this._post({ type: 'settings', data });
    }

    /** Webview URI for a stored avatar, with an mtime query so re-uploads
     *  (stable filename) bust the webview's image cache. */
    private _avatarUrl(info: { path: string; version: number }): string {
        const base = this._panel.webview.asWebviewUri(vscode.Uri.file(info.path)).toString();
        return info.version ? `${base}?v=${info.version}` : base;
    }

    private async _setAvatar(slot: AvatarSlot): Promise<void> {
        if (!this._avatarStorageDir) {
            this._post({ type: 'error', message: t('settings.avatar.unavailable') });
            return;
        }
        const dir = this._avatarStorageDir;
        const picks = await vscode.window.showOpenDialog({
            canSelectMany: false,
            title: t('settings.avatar.dialogTitle'),
            filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        });
        if (!picks?.[0]) return;
        await saveAvatar(dir, slot, picks[0].fsPath);
        await this._sendSettings();
        this._onAvatarsChange?.();
    }

    private async _clearAvatar(slot: AvatarSlot): Promise<void> {
        if (this._avatarStorageDir) await clearAvatar(this._avatarStorageDir, slot);
        await this._sendSettings();
        this._onAvatarsChange?.();
    }

    private async _sendSkills(): Promise<void> {
        try {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
            const skills = await discoverSkills(cwd, await resolveAgentDir());
            this._post({ type: 'skills', skills });
        } catch {
            this._post({ type: 'skills', skills: [] });
        }
    }

    private _detectAuthMethod(provider: string, hasManualKey: boolean): SettingsData['authMethod'] {
        if (hasManualKey) return 'manual';

        const envVarMap: Record<string, string> = {
            anthropic: 'ANTHROPIC_API_KEY',
            openai: 'OPENAI_API_KEY',
            google: 'GEMINI_API_KEY',
            deepseek: 'DEEPSEEK_API_KEY',
        };

        if (provider && envVarMap[provider] && process.env[envVarMap[provider]]) {
            return 'env';
        }

        const fs = require('fs');
        const path = require('path');
        const piAuthDir = path.join(require('os').homedir(), '.pi', 'agent');
        if (fs.existsSync(piAuthDir)) {
            return 'pi-login';
        }

        return 'none';
    }

    private _post(message: SettingsServerMessage): void {
        this._panel.webview.postMessage(message);
    }

    private _dispose(): void {
        SettingsPanel._instance = undefined;
        for (const d of this._disposables) d.dispose();
        this._disposables = [];
    }

    private _getHtml(): string {
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'settings.js'),
        );
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'styles', 'settings.css'),
        );
        const skinsUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'styles', 'skins.css'),
        );
        const nonce = getNonce();
        const fontSize = clampFontSize(vscode.workspace.getConfiguration('pi-agent').get<number>('fontSize', 13));
        const configuredSkin = vscode.workspace.getConfiguration('pi-agent').get<string>('skin', 'default');
        const customPath = this._storageDir ? customSkinPathSync(this._storageDir) : undefined;
        const skin = effectiveSkin(configuredSkin, !!customPath);
        const customVar = skin === 'custom' && customPath
            ? ` --custom-skin-image: url("${this._panel.webview.asWebviewUri(vscode.Uri.file(customPath)).toString().replace(/["\\]/g, '')}");`
            : '';
        const skinOpacity = (clampOpacity(vscode.workspace.getConfiguration('pi-agent').get<number>('customSkinOpacity', 40)) / 100).toFixed(2);

        return `<!DOCTYPE html>
<html lang="en" data-skin="${skin}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; img-src ${this._panel.webview.cspSource} data:; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <link rel="stylesheet" href="${skinsUri}">
    <style>:root { --fs-base: ${fontSize}px; --custom-skin-opacity: ${skinOpacity};${customVar} }</style>
    <title>Pi Agent Settings</title>
</head>
<body>
    <div id="settings-app"></div>
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

export function clampFontSize(size: number): number {
    if (!Number.isFinite(size)) return 13;
    return Math.min(26, Math.max(9, Math.round(size)));
}

/** Custom-skin backdrop strength, 5–80 (percent). */
export function clampOpacity(value: number): number {
    if (!Number.isFinite(value)) return 40;
    return Math.min(80, Math.max(5, Math.round(value)));
}
