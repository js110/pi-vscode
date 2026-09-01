import * as vscode from 'vscode';
import type {
    AgentSession,
    AgentSessionEvent,
    SessionManager,
    ModelRegistry,
    ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type { SerializedAgentState, ModelInfo, SessionInfo, ContextUsageInfo, SkillInfo } from '../shared/protocol';
import { EventRouter } from './events';
import { loadPiSdk, getInstalledPiVersion, hasFunction, type PiSdk } from './compat';
import { mapSkills } from './skills';
import { getModelRuntime, disposeModelRuntime } from './auth';
import { getModelRegistry, getAvailableModels, findModel, disposeModelRegistry } from './models';

export type ToolApprovalHandler = (toolCallId: string, toolName: string, args: any) => Promise<boolean>;

export class PiSessionManager {
    private _session: AgentSession | undefined;
    private _sessionManager: SessionManager | undefined;
    private _modelRegistry: ModelRegistry | undefined;
    private _modelRuntime: ModelRuntime | undefined;
    private _unsubscribe: (() => void) | undefined;
    private _outputChannel: vscode.OutputChannel;
    private _bridgeExtensionPath: string | undefined;
    private _secrets: vscode.SecretStorage | undefined;
    private _toolApprovalHandler: ToolApprovalHandler | undefined;
    readonly events = new EventRouter();

    constructor(
        outputChannel: vscode.OutputChannel,
        bridgeExtensionPath?: string,
        secrets?: vscode.SecretStorage,
    ) {
        this._outputChannel = outputChannel;
        this._bridgeExtensionPath = bridgeExtensionPath;
        this._secrets = secrets;
    }

    get session(): AgentSession | undefined {
        return this._session;
    }

    get isReady(): boolean {
        return this._session !== undefined;
    }

    async initialize(): Promise<void> {
        this._outputChannel.appendLine('Initializing Pi session...');
        const { SessionManager: SM } = await loadPiSdk();

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        this._modelRuntime = await getModelRuntime();
        await this._applyStoredApiKey();
        this._modelRegistry = await getModelRegistry();

        this._sessionManager = this._createSessionManager(SM, cwd);
        const { session, modelFallbackMessage } = await this._createPiSession(cwd, this._sessionManager);

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());

        if (modelFallbackMessage) {
            this._outputChannel.appendLine(`Model fallback: ${modelFallbackMessage}`);
        }

        this._applyDefaultSettings(session);
        this._installToolApprovalHook(session);

        const model = session.model;
        this._outputChannel.appendLine(
            `Pi session initialized (pi-coding-agent ${getInstalledPiVersion()}). Model: ${model ? `${getProviderId(model)}/${model.id}` : 'none'}`
        );
    }

    private _applyDefaultSettings(session: AgentSession): void {
        const config = vscode.workspace.getConfiguration('pi-agent');

        const thinkingLevel = config.get<string>('thinkingLevel', 'off');
        if (thinkingLevel && thinkingLevel !== 'off') {
            session.setThinkingLevel(thinkingLevel as any);
        }

        const defaultProvider = config.get<string>('apiProvider', '');
        const defaultModel = config.get<string>('defaultModel', '');
        if (defaultModel && this._modelRegistry) {
            const available = getAvailableModels(this._modelRegistry);
            const match = available.find(m =>
                m.id === defaultModel && (!defaultProvider || m.provider === defaultProvider)
            );
            if (match) {
                const model = findModel(this._modelRegistry, match.provider, match.id);
                if (model) {
                    session.setModel(model).catch((err: any) => {
                        this._outputChannel.appendLine(`Failed to set default model: ${err.message}`);
                    });
                }
            }
        }
    }

    async prompt(text: string): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        await this._session.prompt(text);
    }

    async steer(text: string): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        if (!hasFunction(this._session, 'steer')) {
            throw new Error("steer() is not available in the installed Pi SDK");
        }
        await this._session.steer(text);
    }

    async followUp(text: string): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        if (!hasFunction(this._session, 'followUp')) {
            throw new Error("followUp() is not available in the installed Pi SDK");
        }
        await this._session.followUp(text);
    }

    getFollowUpMessages(): string[] {
        if (!this._session || !hasFunction(this._session, 'getFollowUpMessages')) { return []; }
        return [...(this._session.getFollowUpMessages() ?? [])];
    }

    async replaceFollowUpMessages(messages: string[]): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        if (hasFunction(this._session, 'clearQueue')) {
            const queued = this._session.clearQueue();
            if (hasFunction(this._session, 'steer')) {
                for (const message of queued.steering) {
                    await this._session.steer(message);
                }
            }
            if (hasFunction(this._session, 'followUp')) {
                for (const message of messages) {
                    await this._session.followUp(message);
                }
            }
        }
    }

    async compact(customInstructions?: string): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        await this._session.compact(customInstructions);
    }

    async setRuntimeApiKey(provider: string, key?: string): Promise<void> {
        this._modelRuntime ??= await getModelRuntime();
        if (key) {
            await this._modelRuntime.setRuntimeApiKey(provider, key);
        } else {
            await this._modelRuntime.removeRuntimeApiKey(provider);
        }
    }

    async abort(): Promise<void> {
        if (!this._session) { return; }
        await this._session.abort();
    }

    async setModel(provider: string, modelId: string): Promise<void> {
        if (!this._session || !this._modelRegistry) {
            throw new Error('Session not initialized');
        }
        const model = findModel(this._modelRegistry, provider, modelId);
        if (!model) {
            throw new Error(`Model not found: ${provider}/${modelId}`);
        }
        await this._session.setModel(model);
    }

    setThinkingLevel(level: string): void {
        if (!this._session || !hasFunction(this._session, 'setThinkingLevel')) { return; }
        this._session.setThinkingLevel(level as any);
    }

    cycleThinkingLevel(): string | undefined {
        if (!this._session || !hasFunction(this._session, 'cycleThinkingLevel')) { return undefined; }
        return this._session.cycleThinkingLevel();
    }

    async newSession(): Promise<void> {
        if (!this._session) { return; }
        this._unsubscribe?.();
        this._session.dispose();

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const { SessionManager: SM } = await loadPiSdk();
        this._sessionManager = this._createSessionManager(SM, cwd);
        const { session } = await this._createPiSession(cwd, this._sessionManager);

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());
        this._applyDefaultSettings(session);
        this._installToolApprovalHook(session);
    }

    async getSessions(): Promise<SessionInfo[]> {
        const { SessionManager: SM } = await loadPiSdk();
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const sessionDir = vscode.workspace.getConfiguration('pi-agent').get<string>('sessionStoragePath', '') || undefined;
        const sessions = await SM.list(cwd, sessionDir);
        return sessions.map((s: any) => ({
            id: s.id ?? s.sessionId ?? '',
            name: s.name ?? s.sessionName,
            path: s.path ?? s.filePath ?? '',
            lastModified: s.modified instanceof Date ? s.modified.getTime() : undefined,
        }));
    }

    async loadSession(sessionPath: string): Promise<void> {
        if (!this._session) { return; }
        this._unsubscribe?.();
        this._session.dispose();

        const { SessionManager: SM } = await loadPiSdk();
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        this._sessionManager = SM.open(sessionPath, undefined);
        const { session } = await this._createPiSession(cwd, this._sessionManager);

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());
        this._installToolApprovalHook(session);
    }

    private _createSessionManager(
        SessionManagerClass: PiSdk['SessionManager'],
        cwd: string,
    ): SessionManager {
        const config = vscode.workspace.getConfiguration('pi-agent');
        if (!config.get<boolean>('autoSaveSessions', true)) {
            return SessionManagerClass.inMemory(cwd);
        }
        const sessionDir = config.get<string>('sessionStoragePath', '') || undefined;
        return SessionManagerClass.create(cwd, sessionDir);
    }

    private async _applyStoredApiKey(): Promise<void> {
        const provider = vscode.workspace.getConfiguration('pi-agent').get<string>('apiProvider', '');
        if (!provider || !this._secrets || !this._modelRuntime) { return; }
        const key = await this._secrets.get(`pi-agent.apiKey.${provider}`);
        if (key) {
            await this._modelRuntime.setRuntimeApiKey(provider, key);
        }
    }

    private async _createPiSession(cwd: string, sessionManager: SessionManager) {
        const {
            createAgentSession,
            DefaultResourceLoader,
            SettingsManager,
            getAgentDir,
        } = await loadPiSdk();
        this._modelRuntime ??= await getModelRuntime();

        const agentDir = getAgentDir();
        const settingsManager = SettingsManager.create(cwd, agentDir);
        const resourceLoader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager,
            additionalExtensionPaths: this._bridgeExtensionPath ? [this._bridgeExtensionPath] : [],
        });
        await resourceLoader.reload();

        const allowedTools = vscode.workspace.getConfiguration('pi-agent').get<string[]>('allowedTools', []);
        return createAgentSession({
            cwd,
            modelRuntime: this._modelRuntime,
            sessionManager,
            settingsManager,
            resourceLoader,
            ...(allowedTools.length > 0 ? { tools: allowedTools } : {}),
        });
    }

    getModels(): ModelInfo[] {
        if (!this._modelRegistry) { return []; }
        return getAvailableModels(this._modelRegistry);
    }

    getCurrentModel(): ModelInfo | undefined {
        const m = this._session?.model;
        if (!m) { return undefined; }
        return { provider: getProviderId(m), id: m.id, name: m.name };
    }

    getThinkingLevel(): string | undefined {
        return this._session?.thinkingLevel;
    }

    getAutoApproveTools(): boolean {
        return vscode.workspace.getConfiguration('pi-agent').get<boolean>('autoApproveTools', false);
    }

    setToolApprovalHandler(handler: ToolApprovalHandler | undefined): void {
        this._toolApprovalHandler = handler;
    }

    private _installToolApprovalHook(session: AgentSession): void {
        try {
            const runner = session.extensionRunner;
            if (!runner) return;

            const origEmitToolCall = runner.emitToolCall.bind(runner);
            const self = this;

            runner.emitToolCall = async (event: any) => {
                const origResult = await origEmitToolCall(event);
                if (origResult?.block) return origResult;
                if (self.getAutoApproveTools()) return origResult;
                if (!self._toolApprovalHandler) return origResult;

                const approved = await self._toolApprovalHandler(
                    event.toolCallId,
                    event.toolName,
                    event.input,
                );
                if (!approved) {
                    return { block: true, reason: 'User rejected tool call' };
                }
                return origResult;
            };
        } catch {
            this._outputChannel.appendLine('Tool approval hook: extension runner not available, skipping');
        }
    }

    getSkills(): SkillInfo[] {
        if (!this._session) return [];
        try {
            const loader = (this._session as any).resourceLoader;
            if (!loader || !hasFunction(loader, 'getSkills')) { return []; }
            const { skills } = loader.getSkills();
            return mapSkills(skills);
        } catch {
            return [];
        }
    }

    getActiveToolNames(): string[] {
        if (!this._session || !hasFunction(this._session, 'getActiveToolNames')) { return []; }
        return this._session.getActiveToolNames();
    }

    getMessages(): any[] {
        try {
            return (this._session as any)?.state?.messages ?? [];
        } catch {
            return [];
        }
    }

    setMessages(msgs: any[]): void {
        try {
            const state = (this._session as any)?.state;
            if (state) {
                state.messages = msgs;
            }
        } catch (err: any) {
            this._outputChannel.appendLine(`[pi-compat] Failed to write session state: ${err?.message ?? err}`);
        }
    }

    serializeState(): SerializedAgentState {
        const s = this._session;
        if (!s) {
            return {
                messages: [],
                isStreaming: false,
                tools: [],
            };
        }
        const model = s.model;
        return {
            messages: (s as any).messages?.map(safeSerialize) ?? [],
            model: model ? { provider: getProviderId(model), id: model.id, name: model.name } : undefined,
            thinkingLevel: s.thinkingLevel,
            isStreaming: s.isStreaming,
            tools: s.getActiveToolNames(),
            sessionId: s.sessionId,
            sessionName: s.sessionName,
            contextUsage: this._getContextUsage(),
        };
    }

    private _getContextUsage(): ContextUsageInfo | undefined {
        const usage = this._session?.getContextUsage?.();
        if (!usage) { return undefined; }
        return {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
        };
    }

    async showModelPicker(): Promise<void> {
        const models = this.getModels();
        if (models.length === 0) {
            vscode.window.showWarningMessage('No models available. Check your Pi configuration.');
            return;
        }
        const items = models.map((m) => ({
            label: m.name ?? m.id,
            description: m.provider,
            model: m,
        }));
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a model',
        });
        if (pick) {
            await this.setModel(pick.model.provider, pick.model.id);
        }
    }

    async dispose(): Promise<void> {
        this._unsubscribe?.();
        this._session?.dispose();
        this._session = undefined;
        this.events.clear();
    }

    static async disposeGlobal(): Promise<void> {
        disposeModelRuntime();
        disposeModelRegistry();
    }
}

function getProviderId(model: any): string {
    return String(model.provider);
}

function safeSerialize(obj: any): any {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return { _serializationFailed: true, type: obj?.type };
    }
}
