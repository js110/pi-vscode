import * as vscode from 'vscode';
import type {
    AgentSession,
    AgentSessionEvent,
    SessionManager,
    ModelRegistry,
    ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type { SerializedAgentState, ModelInfo, SessionInfo, ContextUsageInfo, SkillInfo, CommandInfo } from '../shared/protocol';
import { API_KEY_PREFIX } from '../shared/protocol';
import { modelSupportsImages, type ImagePayload } from '../shared/image-input';
import { EventRouter } from './events';
import { loadPiSdk, getSdkSource, hasFunction, type PiSdk } from './compat';
import { mapSkills } from './skills';
import { getModelRuntime, disposeModelRuntime } from './auth';
import { getModelRegistry, getAvailableModels, findModel, findConfiguredModel, disposeModelRegistry } from './models';
import { TtlCache } from '../shared/ttl-cache';
import { BUILTIN_COMMANDS, isBuiltinSlashCommandName } from '../shared/slash-commands';
import { t } from '../shared/i18n';

export type ToolApprovalHandler = (toolCallId: string, toolName: string, args: any) => Promise<boolean>;

/** Outcome of a session rollback: the message index the store was cut at
 *  (-1 when nothing was suspended) and the removed tail for a later redo. */
export interface RollbackResult {
    cutoff: number;
    suspended: any[];
}

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
    private _sessionsCache = new TtlCache<SessionInfo[]>(5_000);
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
        const src = getSdkSource();
        if (src) {
            const location = src.source === 'system' && src.path ? ` (${src.path})` : '';
            const fallback = src.reason ? ` [using bundled SDK instead: ${src.reason}]` : '';
            this._outputChannel.appendLine(`Pi SDK: ${src.source} copy, v${src.version}${location}${fallback}`);
        }

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
            `Pi session initialized. Model: ${model ? `${getProviderId(model)}/${model.id}` : 'none'}`
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
            const model = findConfiguredModel(this._modelRegistry, defaultProvider, defaultModel);
            if (model) {
                session.setModel(model).catch((err: any) => {
                    this._outputChannel.appendLine(`Failed to set default model: ${err.message}`);
                });
            }
        }
    }

    async prompt(text: string, images?: ImagePayload[]): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        const start = Date.now();
        this._outputChannel.appendLine(`[prompt] called at ${new Date().toISOString()}, text="${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"${images ? `, images=${images.length}` : ''}`);
        try {
            await this._session.prompt(text, images && images.length > 0 ? { images } : undefined);
            this._outputChannel.appendLine(`[prompt] resolved in ${Date.now() - start}ms`);
        } catch (err: any) {
            this._outputChannel.appendLine(`[prompt] rejected in ${Date.now() - start}ms: ${err.message ?? String(err)}`);
            throw err;
        }
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
        this._sessionsCache.invalidate();
    }

    async getSessions(): Promise<SessionInfo[]> {
        const { SessionManager: SM } = await loadPiSdk();
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const sessionDir = vscode.workspace.getConfiguration('pi-agent').get<string>('sessionStoragePath', '') || undefined;
        const key = JSON.stringify([cwd, sessionDir ?? '']);
        const cached = this._sessionsCache.get(key);
        if (cached) {
            return cached.map((s) => ({ ...s }));
        }
        const sessions = await SM.list(cwd, sessionDir);
        const mapped = sessions.map((s: any) => ({
            id: s.id ?? s.sessionId ?? '',
            name: s.name ?? s.sessionName,
            path: s.path ?? s.filePath ?? '',
            lastModified: s.modified instanceof Date ? s.modified.getTime() : undefined,
        }));
        this._sessionsCache.set(key, mapped);
        return mapped.map((s) => ({ ...s }));
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
        this._sessionsCache.invalidate();
    }

    setSessionName(name: string): void {
        const s = this._session;
        if (!s || typeof s.setSessionName !== 'function') return;
        s.setSessionName(name);
        this._sessionsCache.invalidate();
    }

    getCurrentSessionPath(): string | undefined {
        return this._session?.sessionFile;
    }

    getSessionId(): string | undefined {
        return this._session?.sessionId;
    }

    getSessionName(): string | undefined {
        return this._session?.sessionName;
    }

    getContextUsage(): ContextUsageInfo | undefined {
        return this._getContextUsage();
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
        const key = await this._secrets.get(`${API_KEY_PREFIX}${provider}`);
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

    supportsImages(): boolean {
        return modelSupportsImages(this._session?.model as { input?: unknown } | undefined);
    }

    getThinkingLevel(): string | undefined {
        return this._session?.thinkingLevel;
    }

    getAvailableThinkingLevels(): string[] {
        if (!this._session || !hasFunction(this._session, 'getAvailableThinkingLevels')) {
            return [];
        }
        try {
            return this._session.getAvailableThinkingLevels() ?? [];
        } catch {
            return [];
        }
    }

    supportsThinking(): boolean {
        if (!this._session || !hasFunction(this._session, 'supportsThinking')) {
            return false;
        }
        try {
            return this._session.supportsThinking();
        } catch {
            return false;
        }
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

    getCommands(): CommandInfo[] {
        if (!this._session) return [];
        const commands: CommandInfo[] = [];
        // Built-in commands — the SDK doesn't re-export BUILTIN_SLASH_COMMANDS
        // through its public API; the mirror lives in shared/slash-commands.ts
        // (single source shared with the host-side dispatcher). Only commands
        // the host can execute are advertised, so the menu never offers a
        // command whose only outcome is "unsupported".
        for (const builtin of BUILTIN_COMMANDS) {
            if (builtin.support !== 'native') continue;
            commands.push({ name: builtin.name, description: builtin.description, source: 'builtin' });
        }
        // Extension-registered commands
        const runner = (this._session as any).extensionRunner;
        if (runner && hasFunction(runner, 'getRegisteredCommands')) {
            try {
                for (const cmd of runner.getRegisteredCommands()) {
                    // Builtins win in the panel (the host intercepts them
                    // before prompt()); don't advertise unreachable shadows.
                    if (isBuiltinSlashCommandName(cmd.invocationName)) continue;
                    commands.push({
                        name: cmd.invocationName,
                        description: cmd.description ?? '',
                        source: 'extension',
                    });
                }
            } catch { /* ignore */ }
        }
        // Prompt templates
        const templates = (this._session as any).promptTemplates;
        if (Array.isArray(templates)) {
            for (const tpl of templates) {
                commands.push({
                    name: tpl.name,
                    description: tpl.description ?? '',
                    source: 'prompt',
                });
            }
        }
        return commands;
    }

    getActiveToolNames(): string[] {
        if (!this._session || !hasFunction(this._session, 'getActiveToolNames')) { return []; }
        return this._session.getActiveToolNames();
    }

    /** Restrict the active toolset (takes effect on the next agent turn). */
    setActiveToolsByName(toolNames: string[]): void {
        if (!this._session || !hasFunction(this._session, 'setActiveToolsByName')) { return; }
        try {
            this._session.setActiveToolsByName(toolNames);
        } catch (err: any) {
            this._outputChannel.appendLine(`[pi-compat] setActiveToolsByName failed: ${err?.message ?? err}`);
        }
    }

    getMessages(): any[] {
        try {
            return (this._session as any)?.state?.messages ?? [];
        } catch {
            return [];
        }
    }

    /** First index in `messages` whose cumulative user-count exceeds
     *  `rollbackPoint` (Pi counts user turns as the rollback unit). Returns
     *  -1 when nothing lies past the point. */
    static findCutoffIndex(messages: any[], rollbackPoint: number): number {
        let userMsgCount = 0;
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === 'user') {
                userMsgCount++;
                if (userMsgCount > rollbackPoint) {
                    return i;
                }
            }
        }
        return -1;
    }

    /** Roll the session message store back to before `messageIndex`: truncates
     *  every message past the cutoff and returns the tail so the caller can
     *  suspend or discard it. The SDK message shape and the cutoff math stay
     *  inside this adapter — callers only speak in user-turn indices. */
    rollbackTo(messageIndex: number): RollbackResult {
        const messages = this.getMessages();
        const cutoff = PiSessionManager.findCutoffIndex(messages, messageIndex);
        if (cutoff < 0 || cutoff >= messages.length) {
            return { cutoff, suspended: [] };
        }
        const suspended = messages.slice(cutoff);
        this.setMessages(messages.slice(0, cutoff));
        return { cutoff, suspended };
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

    serializeState(includeMessages = true): SerializedAgentState {
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
            ...(includeMessages ? { messages: (s as any).messages?.map(safeSerialize) ?? [] } : {}),
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

    getSessionStats(): any {
        if (!this._session || !hasFunction(this._session, 'getSessionStats')) {
            return undefined;
        }
        try {
            return this._session.getSessionStats();
        } catch {
            return undefined;
        }
    }

    async showModelPicker(): Promise<void> {
        const models = this.getModels();
        if (models.length === 0) {
            vscode.window.showWarningMessage(t('models.noneAvailable'));
            return;
        }
        const items = models.map((m) => ({
            label: m.name ?? m.id,
            description: m.provider,
            model: m,
        }));
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: t('models.selectPlaceholder'),
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
