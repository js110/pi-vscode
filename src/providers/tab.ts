import { PiSessionManager } from '../pi/session';
import { ensureConfigDiscovered, refreshPiConfig } from '../pi/config';
import { ApprovalMemory, type GlobalRuleStore } from '../pi/approval-memory';
import type {
    ApprovalScope,
    ApplyPreviewInfo,
    ClientMessage,
    DropResolveResult,
    MentionSymbolItem,
    QueuedMessage,
    ServerMessage,
    SerializedAgentState,
    SessionInfo,
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
import { buildSessionMarkdown } from '../shared/session-export';
import { SessionLockManager, LOCK_HEARTBEAT_MS, type SessionLockDeps } from '../pi/session-lock';
import { parseUnifiedHunks, applyHunkSelection, applyHunkSelectionToNew } from '../shared/unified-hunks';
import type { SessionPins } from '../utils/session-pins';
import { inMemorySessionPins } from '../utils/session-pins';
import { getRunOutcome, type RunOutcome } from '../shared/run-outcome';
import { probeSessionFile, readSessionChunk, findSnippet, trashSessionFile } from '../utils/session-files';

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
    /**
     * Generate a short conversation title from a session transcript. Optional —
     * when absent the auto-naming feature stays off.
     */
    autoNameSession?(transcript: string): Promise<string | undefined>;
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

/**
 * SDK rejections that mean "the run is busy right now" rather than "your
 * message is invalid" — compaction in progress, or a run that started while
 * we still thought the tab was idle. Pi answers both by queueing.
 */
function isQueueBusyError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /already processing|compaction is in progress/i.test(message);
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
    queuedMessages: QueuedMessage[];
    isStreaming: boolean;
    /**
     * Turn indices booked by prompt calls whose run has not surfaced its
     * first user `message_start` yet. Each queued message lands as its own
     * user message later in the same run and consumes one entry; a surplus
     * entry (or none) means the user message must book a turn itself. An
     * array (not a flag) keeps two prompts racing through mention expansion
     * from stealing each other's accounting.
     */
    pendingPromptTurns: number[];
    /** Count of `queue_update` events seen — lets `_enqueue` skip a
     *  redundant state emit when the SDK event already emitted. */
    queueUpdateCount: number;
    /** Set while a queue replace is replaying entries: the SDK's
     *  synchronous `queue_update` events must not emit intermediate frames. */
    suppressQueueEmit: boolean;
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
    /** Set while the auto-naming model call is in flight (dedup). */
    autoNaming: boolean;
    /** Set once a generated title has been written for this session. */
    autoNamed: boolean;
    /** Latest Pi cache-warming decision (SDK 0.86+; absent on older copies). */
    cacheWarmingDecision?: import('../shared/protocol').CacheWarmingDecisionInfo;
    runOutcome?: RunOutcome;
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
        private _pins: SessionPins = inMemorySessionPins(),
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
            // Images stay host-side: base64 payloads would bloat every frame.
            state.queuedMessages = tab.queuedMessages.map(({ text, kind }) => ({ text, kind }));
        }
        state.compactionPrompt = tab.compactionPrompt;
        state.runOutcome = tab.runOutcome;
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
            pendingPromptTurns: [],
            queueUpdateCount: 0,
            suppressQueueEmit: false,
            compactionStage: 'none' as const,
            compactionPrompt: null,
            compactionInFlight: false,
            lock: this._lockDeps ? new SessionLockManager(this._lockDeps) : null,
            messagesDirty: true,
            imageAssets: new Map<string, string>(),
            imageData: new Map<string, string>(),
            lastTurnDurationSec: 0,
            autoNaming: false,
            autoNamed: false,
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
        // Startup extensions may ask a question. Publish the tab before binding UI,
        // and never block initialize(): responses must be able to dispatch.
        if (tab.session.activateExtensionUi) void tab.session.activateExtensionUi().catch((error: unknown) => this._adapters.ui.showMessage(String(error)));
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
        if (event.type === 'extension_resources_changed') {
            if (tab.id === this._activeTabId) {
                this._adapters.transport.post({ type: 'skills', skills: tab.session.getSkills(), commands: tab.session.getCommands() });
                this._emitStateChange();
            }
            return;
        }
        if (event.type === 'extension_ui_changed') {
            if (tab.id === this._activeTabId) this._emitStateChange();
            return;
        }
        if (event.type === 'extension_notification') {
            if (tab.id === this._activeTabId) this._adapters.ui.showMessage(event.message);
            else tab.hasNotification = true;
            return;
        }
        if (event.type === 'extension_composer') {
            this._adapters.transport.post({ type: 'composerText', tabId: tab.id, text: event.text });
            return;
        }
        if (event.type === 'native_session_changed') {
            void this._syncNativeSession(tab).catch(error => this._adapters.ui.showMessage(String(error)));
            return;
        }
        const isActive = tab.id === this._activeTabId;

        if (event.type === 'agent_start') {
            tab.runOutcome = undefined;
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

        if (event.type === 'message_start' && event.message?.role === 'assistant') {
            // A run emits several assistant messages (tool calls, steering
            // replies, auto-retries). The live bubble mirrors exactly one of
            // them, like the CLI: start a fresh bubble instead of appending to
            // the previous message's text.
            this._clearBubbleFields(tab);
        }

        if (event.type === 'message_start' && event.message?.role === 'user') {
            if (tab.pendingPromptTurns.length > 0) {
                // The prompt turn booked its index before the run started.
                tab.pendingPromptTurns.shift();
            } else {
                // A message drained from the steering/follow-up queue arrives
                // as its own user message mid-run: book a fresh turn for it so
                // checkpoints and diff attribution stay aligned (CLI queues
                // steer/followUp inside the run that is already going).
                tab.turnCounter++;
                tab.checkpointManager.startTurn(tab.turnCounter);
                tab.diffManager.setCurrentTurn(tab.turnCounter);
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
                // The finished message is in the transcript now; the live
                // bubble stands down so its text is not shown twice (and a
                // retried attempt's fragments never linger in the next one).
                this._clearBubbleFields(tab);
            }
        }

        if (event.type === 'agent_end') {
            // A run that never surfaced a user message must not leave the
            // booked indices armed for the next delivery.
            tab.pendingPromptTurns = [];
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
            tab.runOutcome = getRunOutcome(event.aborted === true, tab.session.getMessages());
            this._resetStreaming(tab);
            if (isActive) {
                this._adapters.transport.setContext('pi-agent.isStreaming', false);
            } else {
                tab.hasNotification = true;
            }
            if (tab.runOutcome === 'completed') {
                this._adapters.agent.notifyAgentDone?.(tab.name, tab.lastTurnDurationSec, isActive);
                void this._maybeAutoName(tab);
            }
        }

        if (event.type === 'queue_update') {
            tab.queueUpdateCount++;
            const before = JSON.stringify(tab.queuedMessages);
            this._syncQueuedMessages(tab);
            // Clear-then-replay inside a queue replace fires one event per
            // entry; only the net change may emit, and never mid-replay.
            if (isActive && !tab.suppressQueueEmit
                && JSON.stringify(tab.queuedMessages) !== before) {
                this._emitStateChange();
            }
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
                event.type === 'turn_end' ||
                event.type === 'agent_settled'
            ) {
                this._emitStateChange();
            }
        } else if (
            event.type === 'agent_start' ||
            event.type === 'agent_end' ||
            event.type === 'agent_settled'
        ) {
            this._emitStateChange();
        }
    }

    private _updateTabName(tab: any): void {
        const sessionName = tab.session.getSessionName();
        if (sessionName && tab.name !== sessionName) {
            tab.name = sessionName;
        }
    }

    /** After a finished turn, ask the host model to summarize the session into
     *  a short title. Best-effort: never blocks the turn or signs the session. */
    private async _maybeAutoName(tab: TabState): Promise<void> {
        if (!this._adapters.agent.autoNameSession) return;
        if (tab.autoNaming || tab.autoNamed) return;
        if (tab.session.getSessionName()) return;
        if (!tab.session.getCurrentSessionPath()) return;

        let messages: any[];
        try {
            messages = tab.session.getMessages();
        } catch {
            return;
        }
        if (!messages || messages.length < 2) return;

        let transcript: string;
        try {
            const model = tab.session.getCurrentModel();
            transcript = buildSessionMarkdown(messages, {
                name: tab.name,
                model: model ? (model.name ?? model.id) : undefined,
                exportedAtMs: Date.now(),
            });
        } catch {
            return;
        }

        tab.autoNaming = true;
        try {
            const name = await this._adapters.agent.autoNameSession(transcript.slice(0, 16_000));
            if (!name || this._tabs.get(tab.id) !== tab) return;
            if (tab.session.getSessionName()) return;
            tab.session.setSessionName(name);
            tab.autoNamed = true;
            this._updateTabName(tab);
            this._emitStateChange();
            const currentId = tab.session.getSessionId();
            const sessions = await this._listSessions(tab);
            this._adapters.transport.post({ type: 'sessions', sessions, currentSessionId: currentId });
        } catch {
            // non-critical: the session keeps its default name
        } finally {
            tab.autoNaming = false;
        }
    }

    /** Session list with the user's pinned flags attached. */
    private async _listSessions(tab: TabState): Promise<SessionInfo[]> {
        const sessions = await tab.session.getSessions();
        const pinned = await this._pins.load();
        return sessions.map((s: SessionInfo) => ({
            ...s,
            pinned: pinned.has(s.path),
        }));
    }

    /** Full-text search over session names and file contents (capped). */
    private async _searchSessions(
        tab: TabState,
        query: string,
    ): Promise<SessionInfo[]> {
        const q = query.toLowerCase();
        const all = await tab.session.getSessions();
        if (all.length === 0) return [];
        const pinned = await this._pins.load();
        const hit = new Set<string>();
        const results: SessionInfo[] = [];

        // Name matches are free and most useful.
        for (const s of all) {
            if ((s.name ?? '').toLowerCase().includes(q)) {
                hit.add(s.path);
                results.push({ ...s, pinned: pinned.has(s.path) });
                if (results.length >= 50) return results;
            }
        }

        // Then scan file contents, oldest sessions first, capped by bytes and count.
        let scanned = 0;
        const byDate = [...all].sort(
            (a, b) => (a.lastModified ?? 0) - (b.lastModified ?? 0),
        );
        for (const s of byDate) {
            if (results.length >= 50) break;
            if (hit.has(s.path)) continue;
            if (scanned >= 200) break;
            scanned++;
            const probe = await probeSessionFile(s.path);
            if (!probe || probe.sizeBytes > 2 * 1024 * 1024) continue;
            const chunk = await readSessionChunk(s.path, 512 * 1024);
            const snippet = findSnippet(chunk, q);
            if (snippet !== undefined) {
                results.push({ ...s, pinned: pinned.has(s.path), snippet });
            }
        }
        return results;
    }

    async dispatch(msg: ClientMessage): Promise<void> {
        await this.initialize();
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        if (msg.type === 'extensionUiResponse') { tab.session.extensionUi.respond(msg.id, msg.cancelled ? undefined : msg.value); return; }
        if (msg.type === 'extensionUiInput') { tab.session.extensionUi.input(msg.id, msg.data, msg.width); return; }
        if (msg.type === 'extensionUiClose') { tab.session.extensionUi.close(msg.id); return; }
        if (msg.type === 'composerChanged') { tab.session.extensionUi?.updateComposer(msg.text); return; }
        if (msg.type === 'getSessionTree') { this._postSessionTree(tab); return; }
        if (msg.type === 'navigateSessionTree' || msg.type === 'labelSessionTree' || msg.type === 'openMcp') {
            if (tab.isStreaming || tab.compactionInFlight || this._isReadOnlyLocked(tab)) {
                this._adapters.ui.showMessage(t('slash.blockedStreaming', { name: msg.type === 'openMcp' ? 'mcp' : 'tree' }));
                return;
            }
            try {
                if (msg.type === 'openMcp') await tab.session.openMcp();
                else if (msg.type === 'labelSessionTree') { tab.session.labelSessionTree(msg.entryId, msg.label); this._postSessionTree(tab); }
                else {
                    const result = await tab.session.navigateSessionTree(msg.entryId, msg.summarize, msg.instructions);
                    if (result.changed) await this._syncNativeSession(tab);
                    if (result.editorText !== undefined) this._adapters.transport.post({ type: 'composerText', tabId: tab.id, text: result.editorText });
                    this._postSessionTree(tab);
                }
            } catch (error) { this._adapters.transport.post({ type: 'error', message: humanizeErrorMessage(error) ?? String(error) }); }
            return;
        }

        switch (msg.type) {
            case 'prompt': {
                if (
                    !msg.bypassSlashCommands
                    && (await this._maybeExecuteBuiltinCommand(tab, msg.text))
                ) {
                    break;
                }
                // A streaming tab is not an error: `_sendPromptTurn` reroutes
                // the message into Pi's queue instead of failing the send.
                if (tab.isStreaming) {
                    console.log('[Pi] prompt while streaming: queued');
                }
                if (tab.lock && tab.lock.occupancy !== 'none') {
                    this._adapters.ui.showMessage(t('occupancy.readOnlyBlocked'));
                    break;
                }
                const preparedImages = this._prepareImages(tab, msg.images);
                if (!preparedImages.ok) break;
                const images = preparedImages.images;
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
                {
                    const prepared = this._prepareImages(tab, msg.images);
                    if (!prepared.ok) break;
                    // An idle session never drains its queue — a steer parked
                    // there would sit forever. The SDK streaming flag is the
                    // truth; the host flag only settles at agent_settled.
                    if (!tab.session.isStreaming) {
                        if (!msg.text.trim() && !(prepared.images?.length)) break;
                        await this._sendPromptTurn(tab, msg.text, prepared.images);
                    } else {
                        await this._enqueue(tab, msg.text, prepared.images, 'steer');
                    }
                }
                break;
            case 'queueMessage':
                // A builtin slash command queued while streaming would reach
                // the model as plain text later — execute (or reject) it now.
                if (await this._maybeExecuteBuiltinCommand(tab, msg.text)) {
                    break;
                }
                {
                    const prepared = this._prepareImages(tab, msg.images);
                    if (!prepared.ok) break;
                    if (!tab.session.isStreaming) {
                        if (!msg.text.trim() && !(prepared.images?.length)) break;
                        await this._sendPromptTurn(tab, msg.text, prepared.images);
                    } else {
                        await this._enqueue(tab, msg.text, prepared.images, 'followUp');
                    }
                }
                break;
            case 'editQueuedMessage': {
                // A queue item lives in the SDK's queue and drains past the
                // host — refuse edits that would smuggle a builtin command
                // to the model as plain text.
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
                    const next = [...tab.queuedMessages];
                    next[msg.index] = { ...next[msg.index], text: msg.text.trim() };
                    await this._replaceQueued(tab, next);
                }
                break;
            }
            case 'removeQueuedMessage':
                if (msg.index >= 0 && msg.index < tab.queuedMessages.length) {
                    const next = tab.queuedMessages.filter((_, i) => i !== msg.index);
                    await this._replaceQueued(tab, next);
                }
                break;
            case 'cancelQueue':
                await this._replaceQueued(tab, []);
                break;
            case 'followUp':
                // A builtin reaching the queue drains past the host as plain
                // text — intercept here like queueMessage/steer.
                if (await this._maybeExecuteBuiltinCommand(tab, msg.text)) {
                    break;
                }
                {
                    const prepared = this._prepareImages(tab, msg.images);
                    if (!prepared.ok) break;
                    if (!tab.session.isStreaming) {
                        if (!msg.text.trim() && !(prepared.images?.length)) break;
                        await this._sendPromptTurn(tab, msg.text, prepared.images);
                    } else {
                        await this._enqueue(tab, msg.text, prepared.images, 'followUp');
                    }
                }
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
                if (await tab.session.newSession() === false) break;
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
                if (await tab.session.loadSession(msg.sessionPath) === false) break;
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
                if (msg.openTree) this._postSessionTree(tab);
                break;
            case 'renameSession': {
                const clean = (msg.name ?? '').trim();
                const currentPath = tab.session.getCurrentSessionPath();
                const targetPath = msg.sessionPath;
                if (targetPath && currentPath !== targetPath) {
                    // 方案B：加载目标会话后改名，并停留在该会话
                    if (await tab.session.loadSession(targetPath) === false) break;
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
                const sessions = await this._listSessions(tab);
                const currentId = tab.session.getSessionId();
                this._adapters.transport.post({ type: 'sessions', sessions, currentSessionId: currentId });
                break;
            }
            case 'getSessions': {
                const sessions = await this._listSessions(tab);
                const currentId = tab.session.getSessionId();
                this._adapters.transport.post({ type: 'sessions', sessions, currentSessionId: currentId });
                break;
            }
            case 'deleteSession': {
                const targetPath = msg.sessionPath;
                const all = await tab.session.getSessions();
                const info = all.find((s) => s.path === targetPath);
                const shown = info?.name || targetPath.split(/[\\/]/).pop() || targetPath;
                const yes = await this._adapters.ui.confirmDialog(
                    t('sessions.deleteConfirm', { name: shown }),
                );
                if (!yes) break;
                for (const [tabId, t] of [...this._tabs]) {
                    if (t.session.getCurrentSessionPath() === targetPath) {
                        await this._closeTab(tabId);
                    }
                }
                if (this._tabs.size === 0) {
                    await this.initialize();
                }
                this._pins.set(targetPath, false);
                try {
                    await trashSessionFile(targetPath);
                } catch (err) {
                    // A live SDK session can still hold the file (Windows rename
                    // fails with EPERM/EBUSY) or the path may already be gone.
                    // Keep the entry listed rather than surfacing a hard failure.
                    console.warn(`deleteSession: could not trash ${targetPath}`, err);
                }
                const surviving = this._tabs.get(this._activeTabId);
                if (surviving) {
                    surviving.session.invalidateSessionsCache();
                    const sessions = await this._listSessions(surviving);
                    this._adapters.transport.post({
                        type: 'sessions',
                        sessions,
                        currentSessionId: surviving.session.getSessionId(),
                    });
                }
                break;
            }
            case 'togglePinSession': {
                const pinned = await this._pins.load();
                await this._pins.set(msg.sessionPath, !pinned.has(msg.sessionPath));
                const sessions = await this._listSessions(tab);
                const currentId = tab.session.getSessionId();
                this._adapters.transport.post({ type: 'sessions', sessions, currentSessionId: currentId });
                break;
            }
            case 'searchSessions': {
                const query = (msg.query ?? '').trim();
                const sessions = query
                    ? await this._searchSessions(tab, query)
                    : await this._listSessions(tab);
                const currentId = tab.session.getSessionId();
                this._adapters.transport.post({ type: 'sessions', sessions, currentSessionId: currentId });
                break;
            }
            case 'applyHunks': {
                const result = await tab.diffManager.applyHunks(
                    msg.filePath,
                    msg.toolCallId,
                    msg.hunkIndices,
                );
                this._adapters.transport.post({
                    type: 'hunksApplied',
                    toolCallId: msg.toolCallId,
                    ok: result.ok,
                    message: result.message,
                });
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

    /** Validate composer image payloads; posts an error and rejects on failure. */
    private _prepareImages(
        tab: TabState,
        images?: string[],
    ): { ok: true; images?: ImagePayload[] } | { ok: false } {
        if (!images || images.length === 0) return { ok: true };
        const prepared = preparePromptImages(images);
        if (!prepared.ok) {
            const message =
                prepared.reason === 'tooMany'
                    ? t('image.tooMany', { n: prepared.count })
                    : prepared.reason === 'tooLarge'
                      ? t('image.tooLarge')
                      : t('image.invalid');
            this._adapters.transport.post({ type: 'error', message });
            return { ok: false };
        }
        // The model may have been switched after the images were attached.
        if (!tab.session.supportsImages()) {
            this._adapters.transport.post({ type: 'error', message: t('image.unsupported') });
            return { ok: false };
        }
        return { ok: true, images: prepared.images };
    }

    /**
     * Hand a message to Pi's queue: `steer` joins the run currently in
     * flight, `followUp` waits for it to finish (CLI Enter / Ctrl+Enter).
     */
    private async _enqueue(
        tab: TabState,
        text: string,
        images: ImagePayload[] | undefined,
        kind: QueuedMessage['kind'],
    ): Promise<void> {
        // The SDK dequeues by matching the user message text: an empty-text
        // entry can never leave the queue and would replay as a duplicate on
        // every later edit of the list.
        if (!text.trim()) {
            this._adapters.transport.post({ type: 'error', message: t('image.queueNeedsText') });
            return;
        }
        // Seed the image payload first: `queue_update` fires synchronously
        // inside the SDK call and revives images from the previous list.
        const hint = images?.length
            ? [...tab.queuedMessages, { text, kind, images }]
            : tab.queuedMessages;
        const updatesBefore = tab.queueUpdateCount;
        const isActive = tab.id === this._activeTabId;
        if (kind === 'steer') {
            await tab.session.steer(text, images);
        } else {
            await tab.session.followUp(text, images);
        }
        this._syncQueuedMessages(tab, hint);
        // steer()/followUp() fire `queue_update` synchronously and the event
        // handler already emitted the changed frame — emit here only when it
        // did not (older SDK copies without the event).
        if (isActive && tab.queueUpdateCount === updatesBefore) {
            this._emitStateChange();
        }
    }

    /** Rebuild the queue view from the SDK, re-attaching host-side images.
     *  Alignment is positional per kind — the host list and the SDK queue
     *  hold the same entries in the same order, so a text-first match would
     *  graft attachments onto a duplicate sent without its images. When the
     *  queue shrank (a message was delivered), the pool is aligned to the
     *  tail; when it grew, to the front. */
    private _syncQueuedMessages(tab: TabState, withImages: QueuedMessage[] = []): void {
        const source = withImages.length > 0 ? withImages : tab.queuedMessages;
        const stored: Record<QueuedMessage['kind'], (ImagePayload[] | undefined)[]> = {
            steer: [],
            followUp: [],
        };
        for (const m of source) stored[m.kind].push(m.images);
        const live = tab.session.getQueuedMessages();
        const seen: Record<QueuedMessage['kind'], number> = { steer: 0, followUp: 0 };
        const total: Record<QueuedMessage['kind'], number> = { steer: 0, followUp: 0 };
        for (const e of live) total[e.kind]++;
        tab.queuedMessages = live.map((entry) => {
            const pool = stored[entry.kind];
            const i = seen[entry.kind]++;
            const src = i + Math.max(0, pool.length - total[entry.kind]);
            const images = src >= 0 && src < pool.length ? pool[src] : undefined;
            return images && images.length > 0 ? { ...entry, images } : entry;
        });
    }

    /** Clear and replay the queue with the caller's edited entries. */
    private async _replaceQueued(tab: TabState, next: QueuedMessage[]): Promise<void> {
        const isActive = tab.id === this._activeTabId;
        tab.suppressQueueEmit = true;
        let failed: QueuedMessage[] = [];
        try {
            failed = await tab.session.replaceQueuedMessages(next);
            this._syncQueuedMessages(tab, next);
        } finally {
            tab.suppressQueueEmit = false;
        }
        if (failed.length > 0) {
            this._adapters.ui.showMessage(t('queue.replayFailed', { n: failed.length }));
        }
        if (isActive) this._emitStateChange();
    }

    /** Shared tail of every prompt path: streaming re-check, redo discard,
     *  turn accounting, and the SDK prompt call. `text` must be non-empty
     *  (or images non-empty); caller owns the earlier validation. */
    private async _sendPromptTurn(tab: TabState, text: string, images?: ImagePayload[]): Promise<void> {
        // Mention expansion awaits fs I/O; a run may have started during it.
        // The SDK flag is the truth — the host flag only clears at settle, so
        // trusting it here would park the message on an idle queue.
        if (tab.session.isStreaming) {
            await this._enqueue(tab, text, images, 'steer');
            return;
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
        tab.pendingPromptTurns.push(turnIdx);
        try {
            const sessionId = tab.session.getSessionId();
            const disposition = await tab.session.prompt(text, images);
            if (disposition === 'handled') {
                tab.pendingPromptTurns = tab.pendingPromptTurns.filter(turn => turn !== turnIdx);
                if (tab.turnCounter === turnIdx && sessionId === tab.session.getSessionId()) tab.turnCounter--;
            }
        } catch (err) {
            // The turn never ran: release its index so the next prompt
            // reuses it (checkpoint/rollback math counts user turns).
            tab.pendingPromptTurns = tab.pendingPromptTurns.filter((t) => t !== turnIdx);
            if (tab.turnCounter === turnIdx) {
                tab.turnCounter--;
            }
            if (isQueueBusyError(err) && tab.session.isStreaming) {
                // A run started under us: Pi's own answer to this case is to
                // queue, not to fail the send. Compaction on an idle session
                // rethrows — a followUp parked on an idle queue would never
                // drain.
                await this._enqueue(tab, text, images, 'steer');
                return;
            }
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

    /**
     * Reset only the live-bubble buffers. Unlike `_clearStreamingFields` this
     * leaves the run timing alone, so it is safe to call between assistant
     * messages of the same run.
     */
    private _clearBubbleFields(tab: any): void {
        tab.streamingText = '';
        tab.streamingThinking = '';
        tab.isThinking = false;
        tab.thinkingStartTime = 0;
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
        if (name === 'tree' && !args) { this._postSessionTree(tab); return true; }
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
                if (args) {
                    const model = tab.session.getModels().find(model => `${model.provider}/${model.id}` === args || model.id === args);
                    if (!model) {
                        this._adapters.ui.showMessage(`Unknown Pi model: ${args}`);
                        return true;
                    }
                    await tab.session.setModel(model.provider, model.id);
                    this._emitStateChange();
                    return true;
                }
                await this.selectModel();
                return true;
            case 'thinking': {
                const requested = args.toLowerCase();
                if (requested && !tab.session.getAvailableThinkingLevels().includes(requested)) {
                    this._adapters.ui.showMessage(`Unknown thinking level: ${args}`);
                    return true;
                }
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
            case 'quit':
                await tab.session.abort();
                if (this._tabs.size > 1) await this._closeTab(tab.id);
                else await tab.session.executeBuiltinCommand(name, args);
                return true;
            case 'export':
            case 'reload':
            case 'tree':
            case 'fork':
            case 'clone':
            case 'import':
            case 'scoped-models':
            case 'logout':
            case 'login':
            case 'trust':
            case 'share':
            case 'bug':
            case 'changelog':
            case 'hotkeys': {
                if (tab.isStreaming || tab.compactionInFlight) {
                    this._adapters.ui.showMessage(t('slash.blockedStreaming', { name }));
                    return true;
                }
                if (this._isReadOnlyLocked(tab)) {
                    this._adapters.ui.showMessage(t('occupancy.readOnlyBlocked'));
                    return true;
                }
                try {
                    const result = await tab.session.executeBuiltinCommand(name, args);
                    if (result.changed) {
                        const sessionPath = tab.session.getCurrentSessionPath();
                        if (sessionPath && tab.lock) await tab.lock.adopt(sessionPath);
                        if (['tree', 'fork', 'clone', 'import'].includes(name)) {
                            tab.diffManager.clearAll();
                            tab.checkpointManager.clearAll();
                            tab.suspendedMessages = [];
                            tab.messageMeta.clear();
                            tab.imageAssets.clear();
                            tab.imageData.clear();
                            tab.compactionStage = 'none';
                            tab.compactionPrompt = null;
                            tab.queuedMessages = [];
                        }
                        tab.messagesDirty = true;
                        this._updateTabName(tab);
                        this._emitStateChange();
                        this._adapters.transport.post({ type: 'skills', skills: tab.session.getSkills(), commands: tab.session.getCommands() });
                    }
                    if (result.editorText !== undefined) this._adapters.transport.post({ type: 'composerText', tabId: tab.id, text: result.editorText });
                } catch (error) {
                    this._adapters.transport.post({ type: 'error', message: humanizeErrorMessage(error) ?? String(error) });
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

    private _postSessionTree(tab: TabState): void {
        this._adapters.transport.post({ type: 'sessionTree', tabId: tab.id, entries: tab.session.getSessionTree() });
    }

    private async _syncNativeSession(tab: TabState): Promise<void> {
        const sessionPath = tab.session.getCurrentSessionPath();
        if (sessionPath && tab.lock) await tab.lock.adopt(sessionPath);
        tab.diffManager.clearAll();
        tab.checkpointManager.clearAll();
        tab.suspendedMessages = [];
        tab.messageMeta.clear();
        tab.imageAssets.clear();
        tab.imageData.clear();
        tab.compactionStage = 'none';
        tab.compactionPrompt = null;
        tab.queuedMessages = [];
        tab.runOutcome = undefined;
        tab.turnCounter = tab.session.getMessages().filter(message => message.role === 'user').length;
        tab.messagesDirty = true;
        this._updateTabName(tab);
        if (tab.id === this._activeTabId) {
            this._emitStateChange();
            this._adapters.transport.post({ type: 'skills', skills: tab.session.getSkills(), commands: tab.session.getCommands() });
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

    /** Host entry (editor context menu): prompt, or steer into the running turn. */
    async sendToPi(text: string): Promise<void> {
        await this.initialize();
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        if (tab.isStreaming) {
            await this.dispatch({ type: 'steer', text });
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
