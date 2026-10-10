import * as vscode from 'vscode';
import type {
    AgentSession,
    AgentSessionRuntime,
    AgentSessionEvent,
    SessionManager,
    ModelRegistry,
    ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type { SerializedAgentState, ModelInfo, SessionInfo, ContextUsageInfo, SkillInfo, CommandInfo, CacheWarmingStatusInfo, QueuedMessage } from '../shared/protocol';
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
import { executeNativeCommand } from './native-commands';
import { ExtensionUiBridge } from './extension-ui';
import { nativeExtensionFactories } from './native-extensions';
import { buildSessionToolOptions, type SessionToolOptions } from '../shared/tool-options';
import type { SessionTreeEntryInfo } from '../shared/protocol';

export type ToolApprovalHandler = (toolCallId: string, toolName: string, args: any) => Promise<boolean>;

/** Outcome of a session rollback: the message index the store was cut at
 *  (-1 when nothing was suspended) and the removed tail for a later redo. */
export interface RollbackResult {
    cutoff: number;
    suspended: any[];
}

export class PiSessionManager {
    private _runtime: AgentSessionRuntime | undefined;
    private _approvalRunners = new WeakSet<object>();
    private _cacheWarmingRunners = new WeakSet<object>();
    private _uiReady: Promise<void> | undefined;
    private _uiBoundSessions = new WeakSet<object>();
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
    readonly extensionUi = new ExtensionUiBridge(
        () => this.events.dispatch({ type: 'extension_ui_changed' } as any),
        (message, severity) => this.events.dispatch({ type: 'extension_notification', message, severity } as any),
        text => this.events.dispatch({ type: 'extension_composer', text } as any),
    );

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
        this._installCacheWarmingMonitor(session);

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

        // Only an explicitly-set value overrides Pi's native mode — startup
        // must never clobber a mode the user configured through Pi's CLI.
        const cacheWarming = config.inspect<string>('cacheWarming');
        if (
            cacheWarming?.globalValue !== undefined ||
            cacheWarming?.workspaceValue !== undefined ||
            cacheWarming?.workspaceFolderValue !== undefined
        ) {
            this.setCacheWarmingMode(config.get<string>('cacheWarming', 'streaming'));
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

    async prompt(text: string, images?: ImagePayload[]): Promise<string | void> {
        await this._uiReady;
        if (!this._session) { throw new Error('Session not initialized'); }
        const start = Date.now();
        this._outputChannel.appendLine(`[prompt] called at ${new Date().toISOString()}, text="${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"${images ? `, images=${images.length}` : ''}`);
        try {
            const disposition = await this._session.prompt(text, images && images.length > 0 ? { images } : undefined);
            this._outputChannel.appendLine(`[prompt] resolved in ${Date.now() - start}ms`);
            return disposition;
        } catch (err: any) {
            this._outputChannel.appendLine(`[prompt] rejected in ${Date.now() - start}ms: ${err.message ?? String(err)}`);
            throw err;
        }
    }

    async steer(text: string, images?: ImagePayload[]): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        if (!hasFunction(this._session, 'steer')) {
            throw new Error("steer() is not available in the installed Pi SDK");
        }
        await this._session.steer(text, images && images.length > 0 ? images : undefined);
    }

    async followUp(text: string, images?: ImagePayload[]): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        if (!hasFunction(this._session, 'followUp')) {
            throw new Error("followUp() is not available in the installed Pi SDK");
        }
        await this._session.followUp(text, images && images.length > 0 ? images : undefined);
    }

    /** True while the SDK agent run (or a post-run settle) is active. */
    get isStreaming(): boolean {
        return this._session?.isStreaming === true;
    }

    /**
     * The SDK's full pending queue, steering messages first (they land
     * earlier in the run), each tagged with how it will be delivered.
     */
    getQueuedMessages(): QueuedMessage[] {
        if (!this._session) { return []; }
        const steering = hasFunction(this._session, 'getSteeringMessages')
            ? [...(this._session.getSteeringMessages() ?? [])]
            : [];
        const followUp = hasFunction(this._session, 'getFollowUpMessages')
            ? [...(this._session.getFollowUpMessages() ?? [])]
            : [];
        return [
            ...steering.map((text) => ({ text, kind: 'steer' as const })),
            ...followUp.map((text) => ({ text, kind: 'followUp' as const })),
        ];
    }

    /**
     * Replace the pending queue wholesale (edit / remove / cancel). The SDK
     * only offers `clearQueue()`, so the live queue is read first and the
     * caller's list replayed back in, preserving each entry's delivery kind
     * and attached images.
     *
     * Reconciliation is positional per kind: every requested entry consumes
     * one live slot. Requests beyond the live count name messages that
     * drained while the view was stale — replaying them would resurrect
     * already-delivered messages, so they are dropped and returned as
     * failed. Replay failures (e.g. a run starting mid-replay) are returned
     * the same way instead of failing the whole replace.
     */
    async replaceQueuedMessages(messages: QueuedMessage[]): Promise<QueuedMessage[]> {
        if (!this._session) { throw new Error('Session not initialized'); }
        if (!hasFunction(this._session, 'clearQueue')) { return []; }
        const live = this.getQueuedMessages();
        const replay: QueuedMessage[] = [];
        for (const kind of ['steer', 'followUp'] as const) {
            let slots = live.filter((m) => m.kind === kind).length;
            for (const entry of messages) {
                if (entry.kind !== kind) continue;
                if (slots <= 0) break;
                slots--;
                replay.push(entry);
            }
        }
        this._session.clearQueue();
        const failed: QueuedMessage[] = [];
        for (const message of replay) {
            try {
                if (message.kind === 'steer') {
                    await this.steer(message.text, message.images);
                } else {
                    await this.followUp(message.text, message.images);
                }
            } catch {
                failed.push(message);
            }
        }
        return failed;
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

    async newSession(): Promise<boolean | void> {
        if (!this._session) { return; }
        if (this._runtime && hasFunction(this._runtime, 'newSession')) {
            const result = await this._runtime.newSession();
            if (result.cancelled) return false;
            this._applyDefaultSettings(this._runtime.session);
            return true;
        }
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
        this._installCacheWarmingMonitor(session);
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

    async loadSession(sessionPath: string): Promise<boolean | void> {
        if (!this._session) { return; }
        if (this._runtime && hasFunction(this._runtime, 'switchSession')) {
            const result = await this._runtime.switchSession(sessionPath);
            return !result.cancelled;
        }
        this._unsubscribe?.();
        this._session.dispose();

        const { SessionManager: SM } = await loadPiSdk();
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        this._sessionManager = SM.open(sessionPath, undefined);
        const { session } = await this._createPiSession(cwd, this._sessionManager);

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());
        this._installToolApprovalHook(session);
        this._installCacheWarmingMonitor(session);
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

    /** Drop the cached session list (used after a session file is deleted). */
    invalidateSessionsCache(): void {
        this._sessionsCache.invalidate();
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
        const sdk = await loadPiSdk();
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
            extensionFactories: nativeExtensionFactories(sdk),
            additionalExtensionPaths: this._bridgeExtensionPath ? [this._bridgeExtensionPath] : [],
        });
        await resourceLoader.reload();

        const { tools, excludeTools, skippedExtras } = this._readToolOptions();
        if (skippedExtras.length > 0) {
            this._outputChannel.appendLine(
                `Tool toggles skipped: ${skippedExtras.join(', ')} — Allowed Tools is a plain allowlist; add them there by name.`,
            );
        }
        const result = await createAgentSession({
            cwd,
            modelRuntime: this._modelRuntime,
            sessionManager,
            settingsManager,
            resourceLoader,
            ...(tools ? { tools } : {}),
            ...(excludeTools ? { excludeTools } : {}),
        });
        if (hasFunction(sdk, 'AgentSessionRuntime') && hasFunction(sdk, 'createAgentSessionServices') && hasFunction(sdk, 'createAgentSessionFromServices')) {
            const services = { cwd, agentDir, modelRuntime: this._modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
            this._runtime = new sdk.AgentSessionRuntime(result.session, services, async (options) => {
                const nextToolOptions = this._readToolOptions();
                const nextServices = await sdk.createAgentSessionServices({
                    cwd: options.cwd, agentDir: options.agentDir, modelRuntime: this._modelRuntime,
                    resourceLoaderOptions: { extensionFactories: nativeExtensionFactories(sdk), additionalExtensionPaths: this._bridgeExtensionPath ? [this._bridgeExtensionPath] : [] },
                });
                const next = await sdk.createAgentSessionFromServices({
                    services: nextServices, sessionManager: options.sessionManager,
                    sessionStartEvent: options.sessionStartEvent,
                    ...(nextToolOptions.tools ? { tools: nextToolOptions.tools } : {}),
                    ...(nextToolOptions.excludeTools ? { excludeTools: nextToolOptions.excludeTools } : {}),
                });
                return { ...next, services: nextServices, diagnostics: nextServices.diagnostics };
            });
            this._runtime.setRebindSession(async (session) => {
                this.extensionUi.reset();
                this._unsubscribe?.();
                this._session = session;
                this._sessionManager = session.sessionManager;
                this._unsubscribe = session.subscribe(this.events.asSessionListener());
                this._installToolApprovalHook(session);
                this._installCacheWarmingMonitor(session);
                this._sessionsCache.invalidate();
                await this._bindExtensionUi(session);
                this.events.dispatch({ type: 'native_session_changed' } as any);
            });
        }
        this._installToolApprovalHook(result.session);
        this._installCacheWarmingMonitor(result.session);
        return result;
    }

    async activateExtensionUi(): Promise<void> {
        if (!this._session || this._uiBoundSessions.has(this._session)) return;
        this._uiReady = this._bindExtensionUi(this._session);
        await this._uiReady;
    }

    private async _bindExtensionUi(session: AgentSession): Promise<void> {
        if (this._uiBoundSessions.has(session)) return;
        this._uiBoundSessions.add(session);
        if (!hasFunction(session, 'bindExtensions')) return;
        const sdk = await loadPiSdk();
        if (!hasFunction(sdk, 'Theme')) return;
        if (hasFunction(sdk, 'initTheme')) sdk.initTheme(undefined, false);
        const changed = () => this.events.dispatch({ type: 'native_session_changed' } as any);
        const requireRuntime = () => { if (!this._runtime) throw new Error('Session lifecycle requires Pi 1.x'); return this._runtime; };
        await session.bindExtensions({
            mode: 'tui', uiContext: this.extensionUi.createContext(sdk),
            commandContextActions: {
                waitForIdle: async () => { if (hasFunction(session, 'waitForIdle')) await session.waitForIdle(); },
                newSession: options => requireRuntime().newSession(options),
                switchSession: (file, options) => requireRuntime().switchSession(file, options),
                fork: (id, options) => requireRuntime().fork(id, options),
                navigateTree: async (id, options) => { const result = await session.navigateTree(id, options); if (!result.cancelled) changed(); return result; },
                reload: async () => { await this.reloadResources(); this.events.dispatch({ type: 'extension_resources_changed' } as any); },
            },
            abortHandler: () => { void session.abort(); },
            onError: error => this.events.dispatch({ type: 'extension_notification', severity: 'error', message: error.error } as any),
        });
    }

    async reloadResources(): Promise<void> {
        const session = this._session;
        if (!session || !hasFunction(session, 'reload')) throw new Error('Pi reload is unavailable');
        this.extensionUi.reset();
        await session.reload({ beforeSessionStart: () => {
            this._installToolApprovalHook(session);
            this._installCacheWarmingMonitor(session);
        } });
    }

    getSessionTree(): SessionTreeEntryInfo[] {
        const manager = this._session?.sessionManager;
        if (!manager || !hasFunction(manager, 'getTree')) return [];
        const entries: SessionTreeEntryInfo[] = [];
        const visit = (nodes: ReturnType<SessionManager['getTree']>, depth: number) => {
            for (const node of nodes) {
                const entry = node.entry;
                const message = entry.type === 'message' ? entry.message : undefined;
                const content = message && 'content' in message ? message.content : undefined;
                const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') : entry.type === 'branch_summary' ? entry.summary : '';
                entries.push({ id: entry.id, parentId: entry.parentId, depth, kind: message?.role ?? entry.type,
                    text: text.slice(0, 2000), label: node.label, timestamp: entry.timestamp, current: entry.id === manager.getLeafId() });
                visit(node.children, depth + 1);
            }
        };
        visit(manager.getTree(), 0);
        return entries;
    }

    async navigateSessionTree(id: string, summarize: boolean, instructions?: string): Promise<{ changed?: boolean; editorText?: string }> {
        const session = this._session;
        if (!session || !hasFunction(session, 'navigateTree')) throw new Error('Pi session navigation is unavailable');
        if (!session.sessionManager.getEntry(id)) throw new Error('Session entry no longer exists');
        const result = await session.navigateTree(id, { summarize, customInstructions: instructions });
        return result.cancelled || result.aborted ? {} : { changed: true, editorText: result.editorText };
    }

    labelSessionTree(id: string, label: string): void {
        const manager = this._session?.sessionManager;
        if (!manager || !hasFunction(manager, 'appendLabelChange') || !manager.getEntry(id)) throw new Error('Session entry is unavailable');
        manager.appendLabelChange(id, label.trim() || undefined);
    }

    async executeBuiltinCommand(name: string, args: string): Promise<{ changed?: boolean; editorText?: string }> {
        if (!this._session) throw new Error('Session not initialized');
        if (name === 'reload') { await this.reloadResources(); return { changed: true }; }
        try {
            return await executeNativeCommand(await loadPiSdk(), this._session, this._runtime, name, args, this._secrets);
        } finally {
            if (name === 'reload' || name === 'trust') {
                this._installToolApprovalHook(this._session);
                this._installCacheWarmingMonitor(this._session);
            }
        }
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

    /** Session tool selection from VS Code settings (allowlist/denylist +
     *  codemode/tool-search toggles), re-read per session (re)creation so a
     *  settings change lands on the next session without a reload. */
    private _readToolOptions(): SessionToolOptions {
        const config = vscode.workspace.getConfiguration('pi-agent');
        return buildSessionToolOptions({
            allowedTools: config.get<string[]>('allowedTools', []),
            excludeTools: config.get<string[]>('excludeTools', []),
            enableCodemode: config.get<boolean>('enableCodemode', false),
            enableToolSearch: config.get<boolean>('enableToolSearch', false),
        });
    }

    setToolApprovalHandler(handler: ToolApprovalHandler | undefined): void {
        this._toolApprovalHandler = handler;
    }

    private _installToolApprovalHook(session: AgentSession): void {
        try {
            const runner = session.extensionRunner;
            if (!runner) return;
            if (this._approvalRunners.has(runner)) return;
            this._approvalRunners.add(runner);

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

    /** Runtime cache-warmer status snapshot, or undefined when the installed
     *  SDK predates `AgentSession.cacheWarmingStatus` (SDK 0.86+). */
    getCacheWarmingStatus(): CacheWarmingStatusInfo | undefined {
        const s = this._session;
        if (!s || !('cacheWarmingStatus' in s)) { return undefined; }
        try {
            return (s as any).cacheWarmingStatus;
        } catch {
            return undefined;
        }
    }

    /** Override Pi's native cache-warming mode (writes Pi's global setting).
     *  Only invoked for an explicitly-set VS Code config value, so a mode the
     *  user configured through Pi's CLI (or the SDK default "streaming") is
     *  never clobbered at startup. */
    setCacheWarmingMode(mode: string): void {
        const s = this._session;
        if (!s || !hasFunction(s, 'setCacheWarmingMode')) { return; }
        try {
            (s as any).setCacheWarmingMode(mode);
        } catch (err: any) {
            this._outputChannel.appendLine(`[pi-compat] setCacheWarmingMode failed: ${err?.message ?? err}`);
        }
    }

    /** One-click bug-report summary — the CLI's /bug assist, exposed as an
     *  API (SDK 0.86+; reject cleanly on older copies). */
    async summarizeForBugReport(options: { hint?: string; signal: AbortSignal }): Promise<string> {
        const s = this._session;
        if (!s) { throw new Error('No active session'); }
        if (!hasFunction(s, 'summarizeForBugReport')) {
            throw new Error('summarizeForBugReport is not available in the installed Pi SDK');
        }
        return (s as any).summarizeForBugReport(options);
    }

    /** Pipe Pi's per-refresh warm/stop decision up as tab events (SDK 0.86+;
     *  older copies simply lack the hook and nothing lights up). The original
     *  hook still wins — ours only observes the final action. */
    private _installCacheWarmingMonitor(session: AgentSession): void {
        try {
            const runner = (session as any).extensionRunner;
            if (!runner || typeof runner.emitCacheWarmingDecision !== 'function') { return; }
            if (this._cacheWarmingRunners.has(runner)) return;
            this._cacheWarmingRunners.add(runner);

            const origEmit = runner.emitCacheWarmingDecision.bind(runner);
            const self = this;
            runner.emitCacheWarmingDecision = async (event: any) => {
                let action: string = event?.action ?? 'stop';
                try {
                    const result = await origEmit(event);
                    if (result?.action) { action = result.action; }
                } catch { /* Pi guards its own decision; keep the event default */ }
                try {
                    self.events.dispatch({
                        type: 'cache_warming_decision',
                        phase: event?.phase,
                        warmCost: event?.warmCost,
                        missCost: event?.missCost,
                        continuationProbability: event?.continuationProbability,
                        expectedSavings: event?.expectedSavings,
                        economicsAvailable: event?.economicsAvailable,
                        action,
                    } as any);
                } catch { /* UI surfacing is best-effort */ }
                return action;
            };
        } catch {
            this._outputChannel.appendLine('Cache warming monitor: extension runner not available, skipping');
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
            extensionUi: safeSerialize(this.extensionUi.state),
            model: model ? { provider: getProviderId(model), id: model.id, name: model.name } : undefined,
            thinkingLevel: s.thinkingLevel,
            isStreaming: s.isStreaming,
            tools: s.getActiveToolNames(),
            sessionId: s.sessionId,
            sessionName: s.sessionName,
            contextUsage: this._getContextUsage(),
            cacheWarmingStatus: this.getCacheWarmingStatus(),
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
        this.extensionUi.reset();
        this._unsubscribe?.();
        if (this._runtime) await this._runtime.dispose();
        else this._session?.dispose();
        this._runtime = undefined;
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
