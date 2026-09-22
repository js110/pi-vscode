import { PiSessionManager } from '../pi/session';
import { ensureConfigDiscovered, refreshPiConfig } from '../pi/config';
import { ApprovalMemory, type GlobalRuleStore } from '../pi/approval-memory';
import type {
    ApprovalScope,
    ApplyPreviewInfo,
    ClientMessage,
    DropResolveResult,
    MentionSymbolItem,
    ServerMessage,
    SerializedAgentState,
    TabInfo,
} from '../shared/protocol';
import { DiffManager } from './diff';
import { CheckpointManager } from './checkpoint';
import { decideCompactionPrompt, type CompactionStage } from '../shared/compaction';
import { preparePromptImages, type ImagePayload } from '../shared/image-input';
import { buildAttachContext } from '../shared/attach';
import {
    parseMentionToken,
    hasMentionToken,
    stripMentions,
    buildMentionContext,
    truncateMentionContent,
    extractLines,
    MAX_MENTION_FILE_CHARS,
    MENTION_CONTEXT_WINDOW_LINES,
    type MentionContextEntry,
} from '../shared/mention';
import { t, thinkingLevelLabel, getLang } from '../shared/i18n';
import { humanizeErrorMessage } from '../shared/error-copy';
import {
    classifySlashInput,
    extractLastAssistantText,
    parseBuiltinSlashCommand,
} from '../shared/slash-commands';
import { collectAndReplaceImages } from '../shared/message-assets';
import { buildSessionMarkdown, suggestedExportFileName } from '../shared/session-export';
import { SessionLockManager, LOCK_HEARTBEAT_MS, type SessionLockDeps } from '../pi/session-lock';

export interface Tab {
    id: string;
    name: string;
    session: PiSessionManager;
    diffManager: DiffManager;
    checkpointManager: CheckpointManager;
}

export interface TabFactory {
    create(): Promise<Tab>;
}

/** Push channel: TabManager → webview. */
export interface TransportAdapter {
    post(message: ServerMessage): void;
    setContext(key: string, value: unknown): void;
}

/** Workspace file operations and search. */
export interface WorkspaceAdapter {
    openFile(filePath: string): void;
    getCwd(): string;
    searchFiles(query: string): Promise<string[]>;
    searchSymbols(query: string): Promise<MentionSymbolItem[]>;
    resolveMentionPath(path: string): Promise<string | null>;
    readTextFile(fsPath: string): Promise<string | null>;
    resolveDroppedFiles(uris: string[]): Promise<DropResolveResult[]>;
}

/** User-facing dialogs, settings, and clipboard. */
export interface UIAdapter {
    showMessage(message: string): void;
    confirmDialog(message: string): Promise<boolean>;
    openSettings(): void;
    writeClipboard(text: string): Promise<void>;
}

/** Agent lifecycle capabilities: apply flow, compaction, export, notify. */
export interface AgentCapabilities {
    applyPreview(code: string, lang: string, tabId: string): Promise<ApplyPreviewInfo | null>;
    applyConfirm(previewId: string): Promise<{ ok: boolean; message?: string }>;
    applyCancel(previewId: string): void;
    getCompactionThreshold(): number;
    /** Save `content` to disk under `suggestedName` (user picks the location). */
    exportSession?(content: string, suggestedName: string): Promise<void>;
    /** OS-level turn-completion notification; the host decides when it fires. */
    notifyAgentDone?(tabName: string, durationSec: number, isTabActive: boolean): void;
}

/** All adapter seams the TabManager depends on. */
export interface TabManagerAdapters {
    transport: TransportAdapter;
    workspace: WorkspaceAdapter;
    ui: UIAdapter;
    agent: AgentCapabilities;
}

interface PendingApproval {
    resolve: (approved: boolean) => void;
    toolName: string;
}

interface MessageMeta {
    thinkingDurationSec: number;
    messageEndTime: number;
}

let tabIdCounter = 0;
function nextTabId(): string {
    return `tab-${++tabIdCounter}`;
}

/** Non-persistent fallback used when the host supplies no store. */
function inMemoryGlobalRuleStore(): GlobalRuleStore {
    let rules: import('../shared/protocol').ApprovalRuleInfo[] = [];
    return {
        load: () => rules.map((r) => ({ ...r })),
        save: (next) => {
            rules = next.map((r) => ({ ...r }));
        },
    };
}

function safeSerialize(obj: any): any {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return { type: obj?.type, _serializationFailed: true };
    }
}

/** Internal per-tab runtime state riding on the public Tab record. */
type TabState = Tab & {
    turnCounter: number;
    suspendedMessages: any[];
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    thinkingStartTime: number;
    streamingThinkingDuration: number;
    agentStartTime: number;
    messageMeta: Map<number, MessageMeta>;
    hasNotification: boolean;
    pendingApprovals: Map<string, PendingApproval>;
    approvalMemory: ApprovalMemory;
    queuedMessages: string[];
    isStreaming: boolean;
    compactionStage: CompactionStage;
    compactionPrompt: number | null;
    compactionInFlight: boolean;
    lock: SessionLockManager | null;
    /** True when the serialized message list must be re-shipped (T16). */
    messagesDirty: boolean;
    /** dataUrl payload → stable assetId, deduping image assets per tab. */
    imageAssets: Map<string, string>;
    /** assetId → dataUrl, used to re-ship full image set on webview rebuild. */
    imageData: Map<string, string>;
    /** Wall-clock duration of the last finished turn, for the completion notify. */
    lastTurnDurationSec: number;
    /** Latest Pi cache-warming decision (SDK 0.86+; absent on older copies). */
    cacheWarmingDecision?: import('../shared/protocol').CacheWarmingDecisionInfo;
};

export class TabManager {
    private _tabs = new Map<string, TabState>();
    private _activeTabId = '';
    private _tabSubscriptions = new Map<string, (() => void)[]>();
    private _stateListeners: (() => void)[] = [];
    private _heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    private _initializePromise: Promise<void> | undefined;
    private _imageAssetSeq = 0;

    constructor(
        private _factory: TabFactory,
        private _adapters: TabManagerAdapters,
        private _globalRules: GlobalRuleStore = inMemoryGlobalRuleStore(),
        private _lockDeps?: SessionLockDeps,
    ) {
        if (this._lockDeps) {
            this._heartbeatTimer = setInterval(() => {
                void this._heartbeatAll();
            }, LOCK_HEARTBEAT_MS);
        }
    }

    private async _heartbeatAll(): Promise<void> {
        let changed = false;
        for (const tab of this._tabs.values()) {
            const lock = tab.lock;
            if (!lock || !lock.sessionFile) { continue; }
            const before = lock.occupancy;
            try {
                await lock.heartbeat();
            } catch { /* fs hiccup — retry next tick */ }
            if (lock.occupancy !== before) { changed = true; }
        }
        if (changed) { this._emitStateChange(); }
    }

    /** Idempotent: SDK loading and session creation run once; later calls
     *  await the same ready promise (T16 lazy activation). A failed attempt
     *  clears the cache so a later call can retry. */
    initialize(): Promise<void> {
        this._initializePromise ??= (async () => {
            try {
                const tab = await this._createTabState();
                this._tabs.set(tab.id, tab);
                this._activeTabId = tab.id;
                this._subscribeTab(tab);
            } catch (err) {
                this._initializePromise = undefined;
                throw err;
            }
        })();
        return this._initializePromise;
    }

    get activeTab(): Tab | undefined {
        return this._tabs.get(this._activeTabId);
    }

    /** Record pre-apply content into a specific tab's checkpoint manager. */
    recordFileSnapshot(tabId: string, filePath: string, content: string | null): void {
        this._tabs.get(tabId)?.checkpointManager.recordFileState(filePath, content);
    }

    /** Turn index the most recent dispatched prompt occupies on a tab. */
    getTurnCounter(tabId: string): number | undefined {
        return this._tabs.get(tabId)?.turnCounter;
    }

    /** Whether a specific tab currently has an in-flight agent turn. */
    isTabStreaming(tabId: string): boolean {
        return this._tabs.get(tabId)?.isStreaming ?? false;
    }

    /** Whether the active tab is locked by another window/tab. */
    isReadOnlyLocked(): boolean {
        const tab = this._tabs.get(this._activeTabId);
        return tab?.lock ? tab.lock.occupancy !== 'none' : false;
    }

    /** Apply a VS Code-configured cache-warming mode to the active session
     *  (SDK 0.86+; silently ignored on older copies without the API). */
    setCacheWarmingMode(mode: string): void {
        const tab = this._tabs.get(this._activeTabId);
        if (tab) {
            tab.session.setCacheWarmingMode(mode);
            this._emitStateChange();
        }
    }

    /** Active-session bug-report summary (the CLI's /bug assist). Rejects
     *  while a turn is streaming and when the installed SDK lacks the API. */
    async generateDiagnosticSummary(options: { hint?: string; signal: AbortSignal }): Promise<string> {
        await this.initialize();
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) { throw new Error(t('diagnostic.noSession')); }
        if (tab.isStreaming) { throw new Error(t('diagnostic.busy')); }
        if (!tab.session.summarizeForBugReport) { throw new Error(t('diagnostic.unsupported')); }
        return tab.session.summarizeForBugReport(options);
    }

    /** Roll back every turn after `messageIndex` on a specific tab
     *  (inline-chat discard targets its own tab, not the active one). */
    async restoreCheckpointOnTab(tabId: string, messageIndex: number): Promise<void> {
        const tab = this._tabs.get(tabId);
        if (!tab) return;
        await this._restoreCheckpointOnTab(tab, messageIndex);
    }

    private async _restoreCheckpointOnTab(
        tab: Tab & { suspendedMessages: any[]; messagesDirty: boolean },
        messageIndex: number,
    ): Promise<void> {
        const restored = await tab.checkpointManager.restoreCheckpoint(messageIndex);
        tab.diffManager.suspendChangesAfter(messageIndex);
        tab.messagesDirty = true;

        const { suspended } = tab.session.rollbackTo(messageIndex);
        if (suspended.length > 0) {
            tab.suspendedMessages = suspended;
        }

        if (restored.length > 0) {
            this._adapters.ui.showMessage(t('checkpoint.restored', { n: restored.length }));
        }
        this._emitStateChange();
    }

    get isStreaming(): boolean {
        return this._tabs.get(this._activeTabId)?.isStreaming ?? false;
    }

    onStateChange(listener: () => void): () => void {
        this._stateListeners.push(listener);
        return () => {
            const idx = this._stateListeners.indexOf(listener);
            if (idx >= 0) this._stateListeners.splice(idx, 1);
        };
    }

    /** Push the cached config discovery snapshot (discovering on first call). */
    async postConfigSnapshot(): Promise<void> {
        const config = await ensureConfigDiscovered(this._adapters.workspace.getCwd());
        this._adapters.transport.post({ type: 'configState', config });
    }

    /** Full state plus any first-seen image assets (T16: messages ship only
     *  when they changed; image data travels once via `images`). */
    getSnapshot(force = false): { state: SerializedAgentState; images?: Record<string, string> } {
        return this._buildSnapshot(force, 'send');
    }

    /** Read-only state view: never consumes the dirty flag, never allocates
     *  image assetIds, and omits messages unless forced. */
    getState(force = false): SerializedAgentState {
        return this._buildSnapshot(force, 'read').state;
    }

    private _buildSnapshot(
        force: boolean,
        mode: 'send' | 'read',
    ): { state: SerializedAgentState; images?: Record<string, string> } {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) {
            return { state: { messages: [], isStreaming: false, tools: [] } };
        }

        const needMessages = mode === 'send' ? force || tab.messagesDirty : force;
        const state = tab.session.serializeState(needMessages);
        state.isStreaming = tab.isStreaming;

        let images: Record<string, string> | undefined;
        if (needMessages) {
            if (mode === 'send') {
                tab.messagesDirty = false;
            }
            if (tab.suspendedMessages.length > 0) {
                state.messages = [
                    ...(state.messages ?? []),
                    ...tab.suspendedMessages.map((m: any) => safeSerialize(m)),
                ];
            }

            let assistantOrdinal = 0;
            for (let i = 0; i < (state.messages?.length ?? 0); i++) {
                if (state.messages![i].role === 'assistant') {
                    const meta = tab.messageMeta.get(assistantOrdinal);
                    if (meta) {
                        state.messages![i]._thinkingDurationSec = meta.thinkingDurationSec;
                        state.messages![i]._messageEndTime = meta.messageEndTime;
                    }
                    assistantOrdinal++;
                }
            }

            if (mode === 'send') {
                const assets = collectAndReplaceImages(
                    state.messages ?? [],
                    tab.imageAssets,
                    () => `img-${++this._imageAssetSeq}`,
                );
                state.messages = assets.messages;
                // Persist newly minted assets so webview rebuilds get the full set.
                if (assets.images) {
                    for (const [id, dataUrl] of Object.entries(assets.images)) {
                        tab.imageData.set(id, dataUrl);
                    }
                }
                images = force ? Object.fromEntries(tab.imageData) : assets.images;
            }
        }

        state.fileChanges = tab.diffManager.fileChanges;
        state.rollbackPoint = tab.checkpointManager.rollbackPoint;
        state.tabs = this._getTabInfos();
        state.activeTabId = this._activeTabId;
        state.streamingText = tab.streamingText;
        state.streamingThinking = tab.streamingThinking;
        state.isThinking = tab.isThinking;
        state.thinkingStartTime = tab.thinkingStartTime;
        state.streamingThinkingDuration = tab.streamingThinkingDuration;
        if (tab.queuedMessages.length > 0) {
            state.queuedMessages = tab.queuedMessages;
        }
        state.compactionPrompt = tab.compactionPrompt;
        state.supportsImages = tab.session.supportsImages();
        if (tab.cacheWarmingDecision) {
            state.cacheWarmingDecision = tab.cacheWarmingDecision;
        }
        if (tab.lock && tab.lock.occupancy !== 'none') {
            state.occupancy = tab.lock.occupancy;
        }
        return { state, images };
    }

    private _getTabInfos(): TabInfo[] {
        return [...this._tabs.entries()].map(([id, tab]) => ({
            id,
            name: tab.name,
            isActive: id === this._activeTabId,
            isStreaming: tab.isStreaming,
            hasNotification: tab.hasNotification,
        }));
    }

    private _postModels(tab: any): void {
        this._adapters.transport.post({
            type: 'models',
            models: tab.session.getModels(),
            current: tab.session.getCurrentModel(),
            thinkingLevel: tab.session.getThinkingLevel(),
            availableThinkingLevels: tab.session.getAvailableThinkingLevels(),
            supportsThinking: tab.session.supportsThinking(),
        });
    }

    private async _createTabState() {
        const tab = await this._factory.create();
        return {
            ...tab,
            id: nextTabId(),
            turnCounter: 0,
            suspendedMessages: [],
            streamingText: '',
            streamingThinking: '',
            isThinking: false,
            thinkingStartTime: 0,
            streamingThinkingDuration: 0,
            agentStartTime: 0,
            messageMeta: new Map<number, MessageMeta>(),
            hasNotification: false,
            pendingApprovals: new Map<string, PendingApproval>(),
            approvalMemory: new ApprovalMemory(this._globalRules),
            queuedMessages: [],
            isStreaming: false,
            compactionStage: 'none' as const,
            compactionPrompt: null,
            compactionInFlight: false,
            lock: this._lockDeps ? new SessionLockManager(this._lockDeps) : null,
            messagesDirty: true,
            imageAssets: new Map<string, string>(),
            imageData: new Map<string, string>(),
            lastTurnDurationSec: 0,
            cacheWarmingDecision: undefined,
        };
    }

    private _subscribeTab(tab: any): void {
        const unsubs: (() => void)[] = [];

        unsubs.push(
            tab.session.events.onAll((event: any) => {
                this._handleTabEvent(tab, event);
            }),
        );

        unsubs.push(
            tab.diffManager.onFileChange((change: any) => {
                if (tab.id === this._activeTabId) {
                    this._adapters.transport.post({ type: 'fileChange', change });
                }
            }),
        );

        tab.session.setToolApprovalHandler(
            async (toolCallId: string, toolName: string, args: any) => {
                return this._requestToolApproval(tab, toolCallId, toolName, args);
            },
        );

        this._tabSubscriptions.set(tab.id, unsubs);
    }

    private _unsubscribeTab(tabId: string): void {
        const unsubs = this._tabSubscriptions.get(tabId);
        if (unsubs) {
            for (const unsub of unsubs) unsub();
            this._tabSubscriptions.delete(tabId);
        }
    }

    private _emitStateChange(): void {
        this._checkCompaction();
        for (const listener of this._stateListeners) listener();
    }

    private _checkCompaction(): void {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        const percent = tab.session.getContextUsage()?.percent;
        if (percent == null || !Number.isFinite(percent)) return;
        const threshold = this._adapters.agent.getCompactionThreshold();
        if (percent < threshold) {
            // Usage fell back under the threshold (compact, rollback): close
            // the banner and re-arm so the next climb prompts fresh.
            if (tab.compactionPrompt !== null || tab.compactionStage !== 'none') {
                tab.compactionPrompt = null;
                tab.compactionStage = 'none';
            }
            return;
        }
        const next = decideCompactionPrompt(percent, threshold, tab.compactionStage);
        if (next) {
            tab.compactionStage = next;
            tab.compactionPrompt = percent;
        } else if (tab.compactionPrompt !== null) {
            tab.compactionPrompt = percent;
        }
    }

    /**
     * Validate @-mention tokens at send time (AC-FN-23): refs whose file no
     * longer exists are reported and stripped from the message; valid refs
     * stay visible as `@token` and their content is appended for the model.
     * Tokens the user already deleted from the draft are silently ignored.
     */
    private async _expandMentions(
        text: string,
        tokens: string[],
    ): Promise<{ text: string; invalid: string[] }> {
        const seen = new Set<string>();
        const valid: MentionContextEntry[] = [];
        const invalid: string[] = [];
        for (const token of tokens) {
            if (seen.has(token) || !hasMentionToken(text, token)) continue;
            seen.add(token);
            const ref = parseMentionToken(token);
            if (!ref) {
                invalid.push(token);
                continue;
            }
            const fsPath = await this._adapters.workspace.resolveMentionPath(ref.path);
            if (!fsPath) {
                invalid.push(token);
                continue;
            }
            const raw = await this._adapters.workspace.readTextFile(fsPath);
            if (raw === null) {
                invalid.push(token);
                continue;
            }
            const content = ref.line
                ? extractLines(raw, ref.line, MENTION_CONTEXT_WINDOW_LINES)
                : truncateMentionContent(raw, MAX_MENTION_FILE_CHARS);
            valid.push({ token, ref, content });
        }
        const stripped = stripMentions(text, invalid);
        return { text: stripped + buildMentionContext(valid), invalid };
    }

    private _handleTabEvent(tab: any, event: any): void {
        const isActive = tab.id === this._activeTabId;

        if (event.type === 'agent_start') {
            tab.isStreaming = true;
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
            tab.thinkingStartTime = 0;
            tab.streamingThinkingDuration = 0;
            tab.agentStartTime = Date.now();
            if (isActive) {
                this._adapters.transport.setContext('pi-agent.isStreaming', true);
            }
        }

        if (event.type === 'message_end') {
            // User turns end with message_end too — the new bubble must ship
            // immediately, not only when the assistant replies.
            tab.messagesDirty = true;
            if (event.message?.role === 'assistant') {
                const msgs = tab.session.getMessages();
                let assistantOrdinal = 0;
                let lastOrdinal = -1;
                for (let i = 0; i < msgs.length; i++) {
                    if (msgs[i].role === 'assistant') {
                        lastOrdinal = assistantOrdinal;
                        assistantOrdinal++;
                    }
                }
                if (lastOrdinal >= 0) {
                    tab.messageMeta.set(lastOrdinal, {
                        thinkingDurationSec: tab.streamingThinkingDuration,
                        messageEndTime: Date.now(),
                    });
                }
                tab.streamingThinkingDuration = 0;
            }
        }

        if (event.type === 'agent_end') {
            if (event.willRetry) {
                // SDK will retry — keep streaming state active
                if (isActive) {
                    this._adapters.transport.post({ type: 'agentEvent', event: safeSerialize(event) });
                }
            } else {
                // Capture the wall-clock turn duration before it is cleared;
                // the completion notification fires on agent_settled.
                tab.lastTurnDurationSec = tab.agentStartTime > 0
                    ? (Date.now() - tab.agentStartTime) / 1000
                    : 0;
                // Don't clear isStreaming yet — wait for agent_settled
                // to prevent race condition where user sends new prompt
                // before SDK finishes internal cleanup
                this._clearStreamingFields(tab);
                if (isActive) {
                    this._adapters.transport.post({ type: 'agentEvent', event: safeSerialize(event) });
                } else {
                    tab.hasNotification = true;
                }
            }
        }

        if (event.type === 'agent_settled') {
            this._resetStreaming(tab);
            if (isActive) {
                this._adapters.transport.setContext('pi-agent.isStreaming', false);
            } else {
                tab.hasNotification = true;
            }
            this._adapters.agent.notifyAgentDone?.(tab.name, tab.lastTurnDurationSec, isActive);
        }

        if (event.type === 'queue_update') {
            tab.queuedMessages = [...(event.followUp ?? [])];
        }

        // Custom event from the session manager's cache-warming monitor (not
        // part of Pi's own event stream): surface it through the state frame.
        if (event.type === 'cache_warming_decision') {
            tab.cacheWarmingDecision = event;
            if (isActive) {
                this._emitStateChange();
            }
            return;
        }

        if (!isActive && event.type === 'tool_execution_end' && event.isError) {
            tab.hasNotification = true;
        }

        // A brand-new session's file only exists after its first persisted
        // entry — acquire the single-writer lock at that point.
        if (event.type === 'entry_appended' && tab.lock && !tab.lock.sessionFile) {
            const sessionFile = tab.session.getCurrentSessionPath();
            if (sessionFile) {
                const lock = tab.lock;
                void lock.adopt(sessionFile)
                    .then(() => {
                        if (this._tabs.get(tab.id) !== tab) { return; }
                        if (lock.occupancy !== 'none') { this._emitStateChange(); }
                    })
                    .catch(() => { /* fs hiccup — the heartbeat tick retries */ });
            }
        }

        if (event.type === 'message_update' && event.assistantMessageEvent) {
            const ae = event.assistantMessageEvent;
            switch (ae.type) {
                case 'thinking_start':
                    tab.isThinking = true;
                    tab.streamingThinking = '';
                    tab.thinkingStartTime = Date.now();
                    tab.streamingThinkingDuration = 0;
                    break;
                case 'thinking_delta':
                    tab.streamingThinking += ae.delta ?? '';
                    break;
                case 'thinking_end':
                    tab.isThinking = false;
                    if (tab.thinkingStartTime > 0) {
                        tab.streamingThinkingDuration = Math.round(
                            (Date.now() - tab.thinkingStartTime) / 1000,
                        );
                    }
                    break;
                case 'text_delta':
                    tab.streamingText += ae.delta ?? '';
                    break;
            }
        }

        this._updateTabName(tab);

        if (isActive) {
            this._adapters.transport.post({ type: 'agentEvent', event: safeSerialize(event) });

            if (
                event.type === 'agent_start' ||
                event.type === 'agent_end' ||
                event.type === 'message_end' ||
                event.type === 'turn_end'
            ) {
                this._emitStateChange();
            }
        } else if (event.type === 'agent_start' || event.type === 'agent_end') {
            this._emitStateChange();
        }
    }

    private _updateTabName(tab: any): void {
        const sessionName = tab.session.getSessionName();
        if (sessionName && tab.name !== sessionName) {
            tab.name = sessionName;
        }
    }

    async dispatch(msg: ClientMessage): Promise<void> {
        await this.initialize();
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;

        switch (msg.type) {
            case 'prompt': {
                if (
                    !msg.bypassSlashCommands
                    && (await this._maybeExecuteBuiltinCommand(tab, msg.text))
                ) {
                    break;
                }
                if (tab.isStreaming) {
                    console.log('[Pi] prompt rejected: tab is streaming');
                    throw new Error('Agent is still processing. Please wait or queue your message.');
                }
                if (tab.lock && tab.lock.occupancy !== 'none') {
                    this._adapters.ui.showMessage(t('occupancy.readOnlyBlocked'));
                    break;
                }
                let images: ImagePayload[] | undefined;
                if (msg.images && msg.images.length > 0) {
                    const prepared = preparePromptImages(msg.images);
                    if (!prepared.ok) {
                        const message =
                            prepared.reason === 'tooMany'
                                ? t('image.tooMany', { n: prepared.count })
                                : prepared.reason === 'tooLarge'
                                  ? t('image.tooLarge')
                                  : t('image.invalid');
                        this._adapters.transport.post({ type: 'error', message });
                        break;
                    }
                    // The model may have been switched after the images were attached.
                    if (!tab.session.supportsImages()) {
                        this._adapters.transport.post({ type: 'error', message: t('image.unsupported') });
                        break;
                    }
                    images = prepared.images;
                }
                let text = msg.text;
                if (msg.mentions && msg.mentions.length > 0) {
                    const resolved = await this._expandMentions(text, msg.mentions);
                    if (resolved.invalid.length > 0) {
                        this._adapters.transport.post({
                            type: 'error',
                            message: t('mention.deleted', { path: resolved.invalid.join(', ') }),
                        });
                    }
                    text = resolved.text;
                }
                // Text attachments (non-image files) are appended as fenced
                // context blocks so the model always sees their content.
                if (msg.attachContents && msg.attachContents.length > 0) {
                    text += buildAttachContext(msg.attachContents);
                }
                // Nothing left after stripping dead refs / empty attachments
                // and no images: skip the turn entirely.
                if (!text.trim() && !(images && images.length > 0)) {
                    break;
                }
                await this._sendPromptTurn(tab, text, images);
                break;
            }
            case 'replayTurn': {
                // Roll back to the start of `msg.turn` and re-send it — the
                // edit/resend and regenerate paths share this entry point.
                if (tab.isStreaming) {
                    throw new Error('Agent is still processing. Please wait or queue your message.');
                }
                if (tab.lock && tab.lock.occupancy !== 'none') {
                    this._adapters.ui.showMessage(t('occupancy.readOnlyBlocked'));
                    break;
                }
                let images: ImagePayload[] | undefined;
                if (msg.images && msg.images.length > 0) {
                    // Validate attachments before the destructive rollback so a
                    // failed prep never truncates the session.
                    const prepared = preparePromptImages(msg.images);
                    if (!prepared.ok) {
                        const message =
                            prepared.reason === 'tooMany'
                                ? t('image.tooMany', { n: prepared.count })
                                : prepared.reason === 'tooLarge'
                                  ? t('image.tooLarge')
                                  : t('image.invalid');
                        this._adapters.transport.post({ type: 'error', message });
                        break;
                    }
                    if (!tab.session.supportsImages()) {
                        this._adapters.transport.post({ type: 'error', message: t('image.unsupported') });
                        break;
                    }
                    images = prepared.images;
                }
                const text = msg.text.trim();
                if (!text && !(images && images.length > 0)) {
                    break;
                }
                await this._restoreCheckpointOnTab(tab, Math.max(0, msg.turn - 1));
                await this._sendPromptTurn(tab, text, images);
                break;
            }
            case 'steer':
                // Same interception as queueMessage: a builtin typed while
                // streaming must not reach the model as plain text.
                if (await this._maybeExecuteBuiltinCommand(tab, msg.text)) {
                    break;
                }
                await tab.session.steer(msg.text);
                break;
            case 'queueMessage':
                // A builtin slash command queued while streaming would reach
                // the model as plain text later — execute (or reject) it now.
                if (await this._maybeExecuteBuiltinCommand(tab, msg.text)) {
                    break;
                }
                await tab.session.followUp(msg.text);
                tab.queuedMessages = tab.session.getFollowUpMessages();
                this._emitStateChange();
                break;
            case 'editQueuedMessage': {
                // A queue item lives in the SDK's followUp queue and drains
                // past the host — refuse edits that would smuggle a builtin
                // command to the model as plain text.
                const editedCommand = parseBuiltinSlashCommand(msg.text);
                if (editedCommand) {
                    this._adapters.ui.showMessage(t('slash.blockedStreaming', { name: editedCommand.name }));
                    break;
                }
                if (
                    msg.index >= 0 &&
                    msg.index < tab.queuedMessages.length &&
                    msg.text.trim()
                ) {
                    tab.queuedMessages[msg.index] = msg.text.trim();
                    await tab.session.replaceFollowUpMessages(tab.queuedMessages);
                }
                this._emitStateChange();
                break;
            }
            case 'removeQueuedMessage':
                if (msg.index >= 0 && msg.index < tab.queuedMessages.length) {
                    tab.queuedMessages.splice(msg.index, 1);
                    await tab.session.replaceFollowUpMessages(tab.queuedMessages);
                }
                this._emitStateChange();
                break;
            case 'cancelQueue':
                tab.queuedMessages = [];
                await tab.session.replaceFollowUpMessages([]);
                this._emitStateChange();
                break;
            case 'followUp':
                // A builtin reaching the follow-up queue drains past the host
                // as plain text — intercept here like queueMessage/steer.
                if (await this._maybeExecuteBuiltinCommand(tab, msg.text)) {
                    break;
                }
                await tab.session.followUp(msg.text);
                break;
            case 'abort': {
                await tab.session.abort();
                break;
            }
            case 'getModels': {
                this._postModels(tab);
                break;
            }
            case 'setModel':
                await tab.session.setModel(msg.provider, msg.modelId);
                this._postModels(tab);
                this._emitStateChange();
                break;
            case 'setThinkingLevel':
                tab.session.setThinkingLevel(msg.level);
                this._emitStateChange();
                break;
            case 'newSession':
                await tab.session.newSession();
                if (tab.lock) {
                    await tab.lock.release();
                }
                tab.diffManager.clearAll();
                tab.checkpointManager.clearAll();
                tab.turnCounter = 0;
                this._resetStreaming(tab);
                tab.messageMeta.clear();
                tab.suspendedMessages = [];
                tab.messagesDirty = true;
                tab.queuedMessages = [];
                tab.imageAssets.clear();
                tab.imageData.clear();
                tab.compactionStage = 'none';
                tab.compactionPrompt = null;
                tab.name = 'New Agent';
                tab.cacheWarmingDecision = undefined;
                this._emitStateChange();
                break;
            case 'loadSession':
                await tab.session.loadSession(msg.sessionPath);
                if (tab.lock) {
                    await tab.lock.adopt(msg.sessionPath);
                }
                tab.diffManager.clearAll();
                tab.checkpointManager.clearAll();
                tab.suspendedMessages = [];
                tab.messagesDirty = true;
                tab.queuedMessages = [];
                tab.imageAssets.clear();
                tab.imageData.clear();
                tab.compactionStage = 'none';
                tab.compactionPrompt = null;
                tab.cacheWarmingDecision = undefined;
                this._resetStreaming(tab);
                tab.messageMeta.clear();
                this._updateTabName(tab);
                this._emitStateChange();
                break;
            case 'renameSession': {
                const clean = (msg.name ?? '').trim();
                const currentPath = tab.session.getCurrentSessionPath();
                const targetPath = msg.sessionPath;
                if (targetPath && currentPath !== targetPath) {
                    // 方案B：加载目标会话后改名，并停留在该会话
                    await tab.session.loadSession(targetPath);
                    if (tab.lock) {
                        await tab.lock.adopt(targetPath);
                    }
                    tab.diffManager.clearAll();
                    tab.checkpointManager.clearAll();
                    tab.suspendedMessages = [];
                    tab.messagesDirty = true;
                    tab.queuedMessages = [];
                    this._resetStreaming(tab);
                    tab.messageMeta.clear();
                    tab.session.setSessionName(clean);
                    this._updateTabName(tab);
                } else {
                    tab.session.setSessionName(clean);
                    this._updateTabName(tab);
                }
                this._emitStateChange();
                const sessions = await tab.session.getSessions();
                const currentId = tab.session.getSessionId();
                this._adapters.transport.post({ type: 'sessions', sessions, currentSessionId: currentId });
                break;
            }
            case 'getSessions': {
                const sessions = await tab.session.getSessions();
                const currentId = tab.session.getSessionId();
                this._adapters.transport.post({ type: 'sessions', sessions, currentSessionId: currentId });
                break;
            }
            case 'refreshConfig': {
                const config = await refreshPiConfig(this._adapters.workspace.getCwd());
                this._adapters.transport.post({ type: 'configState', config });
                break;
            }
            case 'applyPreview': {
                try {
                    const preview = await this._adapters.agent.applyPreview(msg.code, msg.lang, tab.id);
                    if (preview) {
                        this._adapters.transport.post({ type: 'applyPreviewResult', preview });
                    }
                } catch (err: unknown) {
                    this._adapters.transport.post({
                        type: 'applyResult',
                        previewId: '',
                        ok: false,
                        message: humanizeErrorMessage(err) ?? t('apply.cancelled'),
                    });
                }
                break;
            }
            case 'applyConfirm': {
                const result = await this._adapters.agent.applyConfirm(msg.previewId);
                this._adapters.transport.post({
                    type: 'applyResult',
                    previewId: msg.previewId,
                    ok: result.ok,
                    message: result.message,
                });
                break;
            }
            case 'applyCancel':
                this._adapters.agent.applyCancel(msg.previewId);
                break;
            case 'compactionAccept': {
                await this._runManualCompaction(tab);
                break;
            }
            case 'compactionDismiss':
                tab.compactionPrompt = null;
                this._emitStateChange();
                break;
            case 'mentionQuery': {
                const [files, symbols] = await Promise.all([
                    this._adapters.workspace.searchFiles(msg.query),
                    this._adapters.workspace.searchSymbols(msg.query),
                ]);
                this._adapters.transport.post({ type: 'mentionResults', requestId: msg.requestId, files, symbols });
                break;
            }
            case 'dropFiles': {
                const results = await this._adapters.workspace.resolveDroppedFiles(msg.uris);
                this._adapters.transport.post({ type: 'dropResolved', requestId: msg.requestId, results });
                break;
            }
            case 'getState': {
                // The eager langChanged pushed at webview resolve races the
                // webview script's listener registration and can be dropped;
                // this handshake is the reliable moment to (re)send it.
                this._adapters.transport.post({ type: 'langChanged', lang: getLang() });
                const { state, images } = this.getSnapshot(true);
                this._adapters.transport.post({ type: 'stateSync', state, images });
                break;
            }
            case 'getSkills': {
                const skills = tab.session.getSkills();
                const commands = tab.session.getCommands();
                this._adapters.transport.post({ type: 'skills', skills, commands });
                break;
            }
            case 'approveToolCall':
                this._resolveToolApproval(tab, msg.toolCallId, true);
                break;
            case 'rejectToolCall':
                this._resolveToolApproval(tab, msg.toolCallId, false);
                break;
            case 'rememberToolApproval': {
                const pending = tab.pendingApprovals.get(msg.toolCallId);
                if (!pending) break;
                const toolName = pending.toolName;
                const scope: ApprovalScope = msg.scope === 'global' ? 'global' : 'session';
                tab.approvalMemory.remember(toolName, scope);
                if (tab.id === this._activeTabId) {
                    this._adapters.transport.post({
                        type: 'approvalTrace',
                        toolCallId: msg.toolCallId,
                        toolName,
                        scope,
                    });
                }
                this._resolveToolApproval(tab, msg.toolCallId, true);
                break;
            }
            case 'openFile':
                this._adapters.workspace.openFile(msg.filePath);
                break;
            case 'openDiff':
                await tab.diffManager.openDiff(msg.filePath, msg.toolCallId);
                break;
            case 'undoFileChange':
                await tab.diffManager.undoFileChange(msg.filePath, msg.toolCallId);
                this._emitStateChange();
                break;
            case 'restoreCheckpoint':
                await this._restoreCheckpointOnTab(tab, msg.messageIndex);
                break;
            case 'redoCheckpoint': {
                const redone = await tab.checkpointManager.redoCheckpoint();
                tab.diffManager.redoChanges();

                if (tab.suspendedMessages.length > 0) {
                    const current = tab.session.getMessages();
                    tab.session.setMessages([...current, ...tab.suspendedMessages]);
                    tab.suspendedMessages = [];
                }
                tab.messagesDirty = true;

                if (redone.length > 0) {
                    this._adapters.ui.showMessage(t('checkpoint.restored', { n: redone.length }));
                }
                this._emitStateChange();
                break;
            }
            case 'confirmAction': {
                const confirmed = await this._adapters.ui.confirmDialog(msg.message);
                this._adapters.transport.post({
                    type: 'confirmResult',
                    action: msg.action,
                    confirmed,
                    payload: msg.payload,
                });
                break;
            }
            case 'createTab':
                await this._createTab();
                break;
            case 'closeTab':
                await this._closeTab(msg.tabId);
                break;
            case 'switchTab':
                this._switchTab(msg.tabId);
                break;
            case 'openSettings':
                this._adapters.ui.openSettings();
                break;
            case 'sessionTakeover':
                if (tab.lock) {
                    await tab.lock.takeover();
                    this._emitStateChange();
                }
                break;
        }
    }

    /** Shared tail of every prompt path: streaming re-check, redo discard,
     *  turn accounting, and the SDK prompt call. `text` must be non-empty
     *  (or images non-empty); caller owns the earlier validation. */
    private async _sendPromptTurn(tab: TabState, text: string, images?: ImagePayload[]): Promise<void> {
        // Mention expansion awaits fs I/O; the streaming state may have
        // flipped during it. Re-check to avoid two concurrent turns.
        if (tab.isStreaming) {
            throw new Error('Agent is still processing. Please wait or queue your message.');
        }
        if (tab.checkpointManager.rollbackPoint !== null) {
            tab.checkpointManager.discardSuspended();
            tab.diffManager.discardSuspended();
            tab.suspendedMessages = [];
            tab.messagesDirty = true;
        }
        tab.turnCounter++;
        const turnIdx = tab.turnCounter;
        tab.checkpointManager.startTurn(turnIdx);
        tab.diffManager.setCurrentTurn(turnIdx);
        try {
            await tab.session.prompt(text, images);
        } catch (err) {
            // The turn never ran: release its index so the next prompt
            // reuses it (checkpoint/rollback math counts user turns).
            tab.turnCounter--;
            throw err;
        }
    }

    private _clearStreamingFields(tab: any): void {
        tab.streamingText = '';
        tab.streamingThinking = '';
        tab.isThinking = false;
        tab.thinkingStartTime = 0;
        tab.streamingThinkingDuration = 0;
        tab.agentStartTime = 0;
    }

    private _resetStreaming(tab: any): void {
        tab.isStreaming = false;
        this._clearStreamingFields(tab);
    }

    private _requestToolApproval(tab: any, toolCallId: string, toolName: string, args: any): Promise<boolean> {
        const decision = tab.approvalMemory.check(toolName);
        if (decision.approved) {
            if (tab.id === this._activeTabId) {
                this._adapters.transport.post({
                    type: 'approvalTrace',
                    toolCallId,
                    toolName,
                    scope: decision.scope ?? 'session',
                });
            }
            return Promise.resolve(true);
        }

        return new Promise<boolean>((resolve) => {
            tab.pendingApprovals.set(toolCallId, { resolve, toolName });

            if (tab.id === this._activeTabId) {
                this._adapters.transport.post({
                    type: 'toolCallPending',
                    pending: { toolCallId, toolName, args: safeSerialize(args) },
                });
            }
        });
    }

    private _resolveToolApproval(tab: any, toolCallId: string, approved: boolean): void {
        const pending = tab.pendingApprovals.get(toolCallId);
        if (pending) {
            tab.pendingApprovals.delete(toolCallId);
            pending.resolve(approved);
            if (tab.id === this._activeTabId) {
                this._adapters.transport.post({ type: 'toolCallResolved', toolCallId });
            }
        }
    }

    private async _createTab(): Promise<void> {
        const tab = await this._createTabState();
        this._tabs.set(tab.id, tab);
        this._subscribeTab(tab);
        this._activeTabId = tab.id;
        this._emitStateChange();
    }

    private async _closeTab(tabId: string): Promise<void> {
        if (this._tabs.size <= 1) return;

        const tab = this._tabs.get(tabId);
        if (!tab) return;

        const wasActive = tabId === this._activeTabId;

        this._unsubscribeTab(tabId);
        tab.diffManager.dispose();
        tab.checkpointManager.dispose();
        void tab.lock?.release();
        await tab.session.dispose();
        this._tabs.delete(tabId);

        if (wasActive) {
            this._activeTabId = this._tabs.keys().next().value!;
            this._tabs.get(this._activeTabId)!.messagesDirty = true;
        }

        this._emitStateChange();
    }

    private _switchTab(tabId: string): void {
        if (!this._tabs.has(tabId) || tabId === this._activeTabId) return;

        this._activeTabId = tabId;

        const tab = this._tabs.get(tabId)!;
        tab.hasNotification = false;
        tab.messagesDirty = true;
        this._adapters.transport.setContext('pi-agent.isStreaming', tab.isStreaming);

        this._emitStateChange();
    }

    async newSession(): Promise<void> {
        await this.dispatch({ type: 'newSession' });
    }

    async abort(): Promise<void> {
        await this.initialize();
        const tab = this._tabs.get(this._activeTabId);
        if (tab) await tab.session.abort();
    }

    async selectModel(): Promise<void> {
        await this.initialize();
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        await tab.session.showModelPicker();
        this._emitStateChange();
    }

    async toggleThinking(): Promise<string | undefined> {
        await this.initialize();
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return undefined;
        const level = tab.session.cycleThinkingLevel();
        this._emitStateChange();
        return level;
    }

    async compact(): Promise<void> {
        await this.initialize();
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        await tab.session.compact();
        tab.messagesDirty = true;
        this._emitStateChange();
    }

    /** SDK-native compaction (T6 banner accept + manual /compact share it). */
    private async _runManualCompaction(tab: TabState, customInstructions?: string): Promise<void> {
        if (tab.compactionInFlight) return;
        tab.compactionInFlight = true;
        try {
            await tab.session.compact(customInstructions);
            tab.compactionInFlight = false;
            tab.compactionPrompt = null;
            // Compaction replaces the message list wholesale via
            // compaction_end — no message_end fires, so re-ship.
            tab.messagesDirty = true;
            // stateSync first: the banner must clear before the result
            // lands, or the live buttons linger for one tick.
            this._emitStateChange();
            this._adapters.transport.post({ type: 'compactionResult', ok: true });
            this._adapters.ui.showMessage(t('compact.done'));
        } catch (err) {
            // Keep the stage: a failed compact still gets the 90% re-prompt.
            tab.compactionInFlight = false;
            tab.compactionPrompt = null;
            this._emitStateChange();
            // "Nothing to compact" is the SDK's normal small-session response
            // (keepRecentTokens defaults to 20k), not a failure — the generic
            // failed copy would mislead.
            const detail = err instanceof Error ? err.message : String(err);
            console.error('[pi-vscode] compaction failed:', detail);
            const benign = /Nothing to compact|session too small|Already compacted/.test(detail);
            const message = benign
                ? t('compact.nothingToCompact')
                : `${t('compact.failed')} ${humanizeErrorMessage(err) ?? detail}`.trim();
            this._adapters.transport.post({ type: 'compactionResult', ok: false, benign, message });
        }
    }

    /** State-changing commands honor the single-writer lock (AC-OP-03). */
    private _isReadOnlyLocked(tab: TabState): boolean {
        return tab.lock !== null && tab.lock.occupancy !== 'none';
    }

    /**
     * Execute a built-in slash command (the SDK prompt() only dispatches
     * extension commands and expands skill/template commands — builtins are
     * the shell's job). Returns true when the input was a builtin and has
     * been handled; false leaves the text on the normal prompt/queue path.
     */
    private async _maybeExecuteBuiltinCommand(tab: TabState, text: string): Promise<boolean> {
        const input = classifySlashInput(text);
        if (input.kind === 'passthrough') return false;
        if (!input.supported) {
            this._adapters.ui.showMessage(t('slash.unsupported', { name: input.name }));
            return true;
        }
        const { name, args } = input;
        // `name` is now SupportedBuiltinCommandName; the exhaustiveness check in
        // the default branch forces a handler whenever the support matrix in
        // shared/slash-commands.ts gains a new native command.
        switch (name) {
            case 'compact':
                if (tab.isStreaming) {
                    this._adapters.ui.showMessage(t('slash.blockedStreaming', { name }));
                    return true;
                }
                if (this._isReadOnlyLocked(tab)) {
                    this._adapters.ui.showMessage(t('occupancy.readOnlyBlocked'));
                    return true;
                }
                if (tab.compactionInFlight) {
                    this._adapters.ui.showMessage(t('compact.compacting'));
                    return true;
                }
                await this._runManualCompaction(tab, args || undefined);
                return true;
            case 'new':
                if (tab.isStreaming) {
                    this._adapters.ui.showMessage(t('slash.blockedStreaming', { name }));
                    return true;
                }
                if (this._isReadOnlyLocked(tab)) {
                    this._adapters.ui.showMessage(t('occupancy.readOnlyBlocked'));
                    return true;
                }
                await this.newSession();
                return true;
            case 'model':
                await this.selectModel();
                return true;
            case 'thinking': {
                const requested = args.toLowerCase();
                if (requested && tab.session.getAvailableThinkingLevels().includes(requested)) {
                    tab.session.setThinkingLevel(requested);
                    this._emitStateChange();
                    this._adapters.ui.showMessage(
                        t('command.thinkingChanged', { level: thinkingLevelLabel(requested) }),
                    );
                    return true;
                }
                const level = tab.session.cycleThinkingLevel();
                this._emitStateChange();
                if (level !== undefined) {
                    this._adapters.ui.showMessage(
                        t('command.thinkingChanged', { level: thinkingLevelLabel(level) }),
                    );
                }
                return true;
            }
            case 'name':
                if (this._isReadOnlyLocked(tab)) {
                    this._adapters.ui.showMessage(t('occupancy.readOnlyBlocked'));
                    return true;
                }
                if (!args) {
                    this._adapters.ui.showMessage(t('slash.nameUsage'));
                    return true;
                }
                // Direct rename — dispatching 'renameSession' would also post
                // the session list and pop the sessions panel open.
                tab.session.setSessionName(args);
                this._updateTabName(tab);
                this._emitStateChange();
                return true;
            case 'resume':
                await this.dispatch({ type: 'getSessions' });
                return true;
            case 'settings':
                this._adapters.ui.openSettings();
                return true;
            case 'login':
                this._adapters.ui.openSettings();
                this._adapters.ui.showMessage(t('slash.loginHint'));
                return true;
            case 'copy': {
                const lastReply = extractLastAssistantText(tab.session.getMessages());
                if (!lastReply) {
                    this._adapters.ui.showMessage(t('slash.copyEmpty'));
                    return true;
                }
                await this._adapters.ui.writeClipboard(lastReply);
                this._adapters.ui.showMessage(t('slash.copied'));
                return true;
            }
            case 'session':
                this._adapters.ui.showMessage(this._buildSessionInfo(tab));
                return true;
            case 'export': {
                // Read-only — allowed mid-stream. Renders the serialized SDK
                // messages to Markdown and lets the host pick a destination.
                const messages = tab.session.getMessages();
                if (messages.length === 0) {
                    this._adapters.ui.showMessage(t('export.empty'));
                    return true;
                }
                const model = tab.session.getCurrentModel();
                const markdown = buildSessionMarkdown(messages, {
                    name: tab.session.getSessionName() ?? tab.name,
                    model: model ? (model.name ?? model.id) : undefined,
                    exportedAtMs: Date.now(),
                });
                const fileName = suggestedExportFileName(
                    tab.session.getSessionName() ?? tab.name,
                    Date.now(),
                );
                try {
                    await this._adapters.agent.exportSession?.(markdown, fileName);
                } catch (err) {
                    const detail = humanizeErrorMessage(err) ?? (err instanceof Error ? err.message : String(err));
                    this._adapters.ui.showMessage(t('export.failed', { message: detail }));
                }
                return true;
            }
            default: {
                const exhaustive: never = name;
                this._adapters.ui.showMessage(t('slash.unsupported', { name: exhaustive }));
                return true;
            }
        }
    }

    private _buildSessionInfo(tab: Tab): string {
        const session = tab.session;
        const model = session.getCurrentModel();
        const modelLabel = model ? (model.name ?? model.id) : '—';
        const usage = session.getContextUsage();
        const usageLabel =
            usage?.percent != null
                ? `${Math.round(usage.percent)}%`
                : usage?.tokens != null
                  ? `${usage.tokens}`
                  : '—';
        return t('slash.sessionInfo', {
            name: session.getSessionName() ?? tab.name,
            model: modelLabel,
            usage: usageLabel,
            path: session.getCurrentSessionPath() ?? '—',
        });
    }

    /** Host entry (editor context menu): prompt, or FollowUp queue while streaming. */
    async sendToPi(text: string): Promise<void> {
        await this.initialize();
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        if (tab.isStreaming) {
            await this.dispatch({ type: 'queueMessage', text });
        } else {
            await this.dispatch({ type: 'prompt', text });
        }
    }

    dispose(): void {
        if (this._heartbeatTimer !== undefined) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = undefined;
        }
        for (const [, unsubs] of this._tabSubscriptions) {
            for (const unsub of unsubs) unsub();
        }
        this._tabSubscriptions.clear();
        for (const tab of this._tabs.values()) {
            tab.diffManager.dispose();
            tab.checkpointManager.dispose();
            void tab.lock?.release();
        }
        this._tabs.clear();
        this._stateListeners = [];
        // Allow a fresh webview resolve to initialize again (M4: otherwise the
        // cached promise resolves against the now-empty tab set forever).
        this._initializePromise = undefined;
    }
}
