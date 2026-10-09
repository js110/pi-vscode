import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentSession, AgentSessionRuntime } from '@earendil-works/pi-coding-agent';
import type { PiSdk } from './compat';
import { getSdkSource, hasFunction } from './compat';
import { API_KEY_PREFIX } from '../shared/protocol';

const execFileAsync = promisify(execFile);
export interface NativeCommandResult { changed?: boolean; editorText?: string }

/** TUI builtins need a host UI; never send them to the model as prompts. */
export async function executeNativeCommand(
    sdk: PiSdk, session: AgentSession, runtime: AgentSessionRuntime | undefined,
    name: string, args: string, secrets?: vscode.SecretStorage,
): Promise<NativeCommandResult> {
    const requireMethod = (object: unknown, method: string) => {
        if (!hasFunction(object, method)) throw new Error(`The loaded Pi SDK does not provide ${method}. Update Pi and reload the extension.`);
    };
    switch (name) {
        case 'login': {
            const modelRuntime = session.modelRuntime;
            requireMethod(modelRuntime, 'getProviders');
            const providers = modelRuntime.getProviders();
            const providerId = args || (await vscode.window.showQuickPick(providers.map(provider => ({ label: provider.name, id: provider.id })), { title: 'Pi: Log in provider' }))?.id;
            if (!providerId) return {};
            const provider = modelRuntime.getProvider(providerId);
            if (!provider) throw new Error(`Unknown provider: ${providerId}`);
            const methods = [
                ...(provider.auth.oauth ? [{ label: provider.auth.oauth.name, type: 'oauth' as const }] : []),
                ...(provider.auth.apiKey?.login ? [{ label: provider.auth.apiKey.name, type: 'api_key' as const }] : []),
            ];
            const method = methods.length === 1 ? methods[0] : await vscode.window.showQuickPick(methods, { title: 'Pi: Authentication method' });
            if (!method) return {};
            if (method.type === 'api_key') {
                if (!secrets) throw new Error('VS Code SecretStorage is unavailable');
                const key = await vscode.window.showInputBox({ title: `Pi: ${provider.name} API key`, password: true, ignoreFocusOut: true });
                if (!key) return {};
                await secrets.store(`${API_KEY_PREFIX}${providerId}`, key);
                await modelRuntime.setRuntimeApiKey(providerId, key);
            } else {
                requireMethod(modelRuntime, 'login');
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pi: Log in to ${provider.name}`, cancellable: true }, async (progress, token) => {
                    const controller = new AbortController();
                    const cancellation = token.onCancellationRequested(() => controller.abort());
                    try {
                        await modelRuntime.login(providerId, 'oauth', {
                            signal: controller.signal,
                            prompt: async prompt => {
                                const source = new vscode.CancellationTokenSource();
                                const cancel = () => source.cancel();
                                controller.signal.addEventListener('abort', cancel);
                                prompt.signal?.addEventListener('abort', cancel);
                                if (controller.signal.aborted || prompt.signal?.aborted) source.cancel();
                                try {
                                    const answer = prompt.type === 'select'
                                        ? (await vscode.window.showQuickPick(prompt.options.map(option => ({ ...option, label: option.label })), { title: prompt.message }, source.token))?.id
                                        : await vscode.window.showInputBox({ prompt: prompt.message, placeHolder: prompt.placeholder, password: prompt.type === 'secret', ignoreFocusOut: true }, source.token);
                                    if (answer === undefined) throw new Error('Login cancelled');
                                    return answer;
                                } finally {
                                    controller.signal.removeEventListener('abort', cancel);
                                    prompt.signal?.removeEventListener('abort', cancel);
                                    source.dispose();
                                }
                            },
                            notify: event => {
                                if (event.type === 'auth_url') void vscode.env.openExternal(vscode.Uri.parse(event.url));
                                else if (event.type === 'device_code') {
                                    progress.report({ message: `Code: ${event.userCode}` });
                                    void vscode.env.openExternal(vscode.Uri.parse(event.verificationUri));
                                } else progress.report({ message: event.message });
                            },
                        });
                    } finally { cancellation.dispose(); }
                });
            }
            return { changed: true };
        }
        case 'quit':
            await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
            return {};
        case 'reload':
            requireMethod(session, 'reload');
            await session.reload();
            return { changed: true };
        case 'tree': {
            requireMethod(session, 'navigateTree');
            const items: Array<vscode.QuickPickItem & { id: string }> = [];
            const visit = (nodes: ReturnType<typeof session.sessionManager.getTree>, depth: number) => {
                for (const node of nodes) {
                    const entry = node.entry;
                    const message = entry.type === 'message' ? entry.message : undefined;
                    const content = message && 'content' in message ? message.content : undefined;
                    const text = typeof content === 'string' ? content : Array.isArray(content)
                        ? content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(' ') : '';
                    items.push({ id: entry.id, label: `${'  '.repeat(depth)}${message?.role ?? entry.type}: ${text.replace(/\s+/g, ' ').slice(0, 120)}`,
                        description: node.label, detail: entry.id === session.sessionManager.getLeafId() ? 'Current branch position' : entry.id });
                    visit(node.children, depth + 1);
                }
            };
            visit(session.sessionManager.getTree(), 0);
            const selected = args ? items.find(item => item.id === args) : await vscode.window.showQuickPick(items, { title: 'Pi: Session tree', matchOnDetail: true });
            if (args && !selected) throw new Error(`Unknown session entry: ${args}`);
            if (!selected || selected.id === session.sessionManager.getLeafId()) return {};
            const summary = await vscode.window.showQuickPick(['No summary', 'Summarize abandoned branch'], { title: 'Pi: Switch branch' });
            if (!summary) return {};
            const result = await session.navigateTree(selected.id, { summarize: summary !== 'No summary' });
            return result.cancelled ? {} : { changed: true, editorText: result.editorText };
        }
        case 'fork':
        case 'clone': {
            requireMethod(runtime, 'fork');
            const entries = session.getUserMessagesForForking();
            const selected = name === 'clone' ? session.sessionManager.getLeafId()
                : args || (await vscode.window.showQuickPick(entries.map(entry => ({ label: entry.text.slice(0, 120), id: entry.entryId })), { title: 'Pi: Fork before user message' }))?.id;
            if (!selected) return {};
            const result = await runtime!.fork(selected, { position: name === 'clone' ? 'at' : 'before' });
            return result.cancelled ? {} : { changed: true, editorText: result.selectedText ?? '' };
        }
        case 'import': {
            requireMethod(runtime, 'importFromJsonl');
            const input = args || (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Pi session': ['jsonl'] } }))?.[0]?.fsPath;
            if (!input) return {};
            const result = await runtime!.importFromJsonl(path.resolve(session.sessionManager.getCwd(), input));
            return { changed: !result.cancelled };
        }
        case 'export': {
            const uri = args ? vscode.Uri.file(path.resolve(session.sessionManager.getCwd(), args)) : await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(session.sessionManager.getCwd(), 'pi-session.html')), filters: { HTML: ['html'], 'Pi session': ['jsonl'] },
            });
            if (!uri) return {};
            const method = uri.fsPath.endsWith('.jsonl') ? 'exportToJsonl' : 'exportToHtml';
            requireMethod(session, method);
            await session[method](uri.fsPath);
            void vscode.window.showInformationMessage(`Pi session exported: ${uri.fsPath}`);
            return {};
        }
        case 'scoped-models': {
            requireMethod(session, 'setScopedModels');
            const models = session.modelRuntime.getAvailableSnapshot();
            const selected = await vscode.window.showQuickPick(models.map(model => ({ label: `${model.provider}/${model.id}`, model,
                picked: session.scopedModels.some(item => item.model.provider === model.provider && item.model.id === model.id) })),
                { title: 'Pi: Models available for cycling', canPickMany: true });
            if (!selected) return {};
            session.setScopedModels(selected.map(item => ({ model: item.model })));
            session.settingsManager.setEnabledModels(selected.length ? selected.map(item => item.label) : undefined);
            return { changed: true };
        }
        case 'logout': {
            requireMethod(session.modelRuntime, 'logout');
            const credentials = await session.modelRuntime.listCredentials();
            const provider = args || await vscode.window.showQuickPick(credentials.map(item => item.providerId), { title: 'Pi: Log out provider' });
            if (!provider) return {};
            await session.modelRuntime.logout(provider);
            await session.modelRuntime.removeRuntimeApiKey(provider);
            await secrets?.delete(`${API_KEY_PREFIX}${provider}`);
            return { changed: true };
        }
        case 'trust': {
            requireMethod(sdk, 'ProjectTrustStore');
            const decision = await vscode.window.showQuickPick(['Trust project', 'Do not trust project', 'Forget saved decision'], { title: `Pi: Project trust — ${session.sessionManager.getCwd()}` });
            if (!decision) return {};
            new sdk.ProjectTrustStore(sdk.getAgentDir()).set(session.sessionManager.getCwd(), decision === 'Forget saved decision' ? null : decision === 'Trust project');
            await session.reload();
            return { changed: true };
        }
        case 'share': {
            const choice = await vscode.window.showWarningMessage('Upload this session transcript as a secret GitHub gist? Anyone with the link can read it.', { modal: true }, 'Upload');
            if (!choice) return {};
            const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-vscode-share-'));
            try {
                const file = await session.exportToHtml(path.join(directory, 'session.html'));
                const { stdout } = await execFileAsync('gh', ['gist', 'create', '--public=false', file], { windowsHide: true });
                const url = stdout.trim();
                await vscode.env.clipboard.writeText(url);
                void vscode.window.showInformationMessage(`Session shared (link copied): ${url}`);
            } finally {
                await fs.rm(directory, { recursive: true, force: true });
            }
            return {};
        }
        case 'bug':
            await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/earendil-works/pi/issues/new?title=${encodeURIComponent(args || 'Pi bug report')}`));
            return {};
        case 'changelog': {
            const source = getSdkSource();
            let directory = source?.path ?? path.resolve(__dirname, '..', 'node_modules', '@earendil-works', 'pi-coding-agent');
            for (let i = 0; i < 8; i++, directory = path.dirname(directory)) {
                const file = path.join(directory, 'CHANGELOG.md');
                try { await fs.access(file); await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file)); return {}; } catch { /* find package root */ }
            }
            await vscode.env.openExternal(vscode.Uri.parse('https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md'));
            return {};
        }
        case 'hotkeys':
            await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'pi-agent');
            return {};
        default:
            throw new Error(`No native command handler for /${name}`);
    }
}
