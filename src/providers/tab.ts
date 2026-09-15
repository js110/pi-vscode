import type { PiSessionManager } from '../pi/session';
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
import { PLAN_DANGEROUS_REASON } from '../shared/protocol';
import { DiffManager } from './diff';
import { CheckpointManager } from './checkpoint';
import { decideCompactionPrompt, type CompactionStage } from '../shared/compaction';
import { preparePromptImages, type ImagePayload } from '../shared/image-input';
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
import { t } from '../shared/i18n';
import { isDangerousTool } from '../shared/tool-safety';
import {
    PlanMachine,
    parsePlanBlock,
    PLAN_CREDENTIAL_TOOLS,
    PLAN_READONLY_TOOLS,
} from './plan';

function planningPrompt(task: string): string {
    return `${task}\n\nYou are in Plan mode: use read-only tools only. Analyze the task, then end your reply with the final plan in a fenced block tagged \`plan\` — one short imperative step per line and nothing else inside the block.`;
}

function replanPrompt(feedback?: string): string {
    const reason = feedback && feedback.trim() ? `:\n\n${feedback.trim()}` : '.';
    return `The current plan needs adjustment${reason}\n\nRe-plan accordingly and end your reply with the updated plan in a fenced block tagged \`plan\` — one short imperative step per line.`;
}

function stepPrompt(step: string, index: number, total: number): string {
    return `Plan step ${index + 1}/${total}: ${step}\n\nExecute exactly this step of the approved plan now. Do not start any other step.`;
}

/** Per-tab Plan mode runtime: the pure machine plus tab-glue bookkeeping. */
interface PlanRuntime {
    machine: PlanMachine;
    /** Active toolset saved before the read-only restriction; null = unrestricted. */
    savedTools: string[] | null;
    /** Bumped to invalidate an in-flight step-execution driver. */
    runId: number;
    driverActive: boolean;
    /** Set when the user aborted during a planning turn (suppresses no-plan error). */
    abortSeen: boolean;
    /** Plan steps parsed from the planning turn's own message_end (queued
     *  turns may drain in the same run, so settle-time parsing is unreliable). */
    capturedSteps: string[] | null;
}

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

export interface TabManagerHooks {
    post(message: ServerMessage): void;
    setContext(key: string, value: unknown): void;
    openFile(filePath: string): void;
    showMessage(message: string): void;
    confirmDialog(message: string): Promise<boolean>;
    openSettings(): void;
    getCwd(): string;
    applyPreview(code: string, lang: string, tabId: string): Promise<ApplyPreviewInfo | null>;
    applyConfirm(previewId: string): Promise<{ ok: boolean; message?: string }>;
    applyCancel(previewId: string): void;
    getCompactionThreshold(): number;
    searchFiles(query: string): Promise<string[]>;
    searchSymbols(query: string): Promise<MentionSymbolItem[]>;
    resolveMentionPath(path: string): Promise<string | null>;
    readTextFile(fsPath: string): Promise<string | null>;
    resolveDroppedFiles(uris: string[]): Promise<DropResolveResult[]>;
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

export class TabManager {
    private _tabs = new Map<string, Tab & {
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
        plan: PlanRuntime;
    }>();
    private _activeTabId = '';
    private _tabSubscriptions = new Map<string, (() => void)[]>();
    private _stateListeners: (() => void)[] = [];

    constructor(
        private _factory: TabFactory,
        private _hooks: TabManagerHooks,
        private _globalRules: GlobalRuleStore = inMemoryGlobalRuleStore(),
    ) {}

    async initialize(): Promise<void> {
        const tab = await this._createTabState();
        this._tabs.set(tab.id, tab);
        this._activeTabId = tab.id;
        this._subscribeTab(tab);
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

    /** Roll back every turn after `messageIndex` on a specific tab
     *  (inline-chat discard targets its own tab, not the active one). */
    async restoreCheckpointOnTab(tabId: string, messageIndex: number): Promise<void> {
        const tab = this._tabs.get(tabId);
        if (!tab) return;
        await this._restoreCheckpointOnTab(tab, messageIndex);
    }

    private async _restoreCheckpointOnTab(
        tab: Tab & { suspendedMessages: any[] },
        messageIndex: number,
    ): Promise<void> {
        const restored = await tab.checkpointManager.restoreCheckpoint(messageIndex);
        tab.diffManager.suspendChangesAfter(messageIndex);

        const allMsgs = tab.session.getMessages();
        const cutoff = this._findCutoffIndex(allMsgs, messageIndex);
        if (cutoff >= 0 && cutoff < allMsgs.length) {
            tab.suspendedMessages = allMsgs.slice(cutoff);
            tab.session.setMessages(allMsgs.slice(0, cutoff));
        }

        if (restored.length > 0) {
            this._hooks.showMessage(t('checkpoint.restored', { n: restored.length }));
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
        const config = await ensureConfigDiscovered(this._hooks.getCwd());
        this._hooks.post({ type: 'configState', config });
    }

    getState(): SerializedAgentState {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) {
            return { messages: [], isStreaming: false, tools: [] };
        }

        const state = tab.session.serializeState();
        state.isStreaming = tab.isStreaming;
        if (tab.suspendedMessages.length > 0) {
            state.messages = [
                ...state.messages,
                ...tab.suspendedMessages.map((m: any) => safeSerialize(m)),
            ];
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
        state.plan = tab.plan.machine.snapshot();

        let assistantOrdinal = 0;
        for (let i = 0; i < state.messages.length; i++) {
            if (state.messages[i].role === 'assistant') {
                const meta = tab.messageMeta.get(assistantOrdinal);
                if (meta) {
                    state.messages[i]._thinkingDurationSec = meta.thinkingDurationSec;
                    state.messages[i]._messageEndTime = meta.messageEndTime;
                }
                assistantOrdinal++;
            }
        }
        return state;
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
        this._hooks.post({
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
            plan: {
                machine: new PlanMachine(),
                savedTools: null,
                runId: 0,
                driverActive: false,
                abortSeen: false,
                capturedSteps: null,
            },
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
                    this._hooks.post({ type: 'fileChange', change });
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
        const threshold = this._hooks.getCompactionThreshold();
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
            const fsPath = await this._hooks.resolveMentionPath(ref.path);
            if (!fsPath) {
                invalid.push(token);
                continue;
            }
            const raw = await this._hooks.readTextFile(fsPath);
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
                this._hooks.setContext('pi-agent.isStreaming', true);
            }
        }

        if (event.type === 'message_end' && event.message?.role === 'assistant') {
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
            if (tab.plan.machine.snapshot().phase === 'planning') {
                const titles = parsePlanBlock(this._assistantText(event.message));
                if (titles.length > 0) {
                    tab.plan.capturedSteps = titles;
                }
            }
        }

        if (event.type === 'agent_end') {
            if (event.willRetry) {
                // SDK will retry — keep streaming state active
                if (isActive) {
                    this._hooks.post({ type: 'agentEvent', event: safeSerialize(event) });
                }
            } else {
                // Don't clear isStreaming yet — wait for agent_settled
                // to prevent race condition where user sends new prompt
                // before SDK finishes internal cleanup
                this._clearStreamingFields(tab);
                if (isActive) {
                    this._hooks.post({ type: 'agentEvent', event: safeSerialize(event) });
                } else {
                    tab.hasNotification = true;
                }
            }
        }

        if (event.type === 'agent_settled') {
            this._resetStreaming(tab);
            this._maybeFinishPlanning(tab);
            if (isActive) {
                this._hooks.setContext('pi-agent.isStreaming', false);
            } else {
                tab.hasNotification = true;
            }
        }

        if (event.type === 'queue_update') {
            tab.queuedMessages = [...(event.followUp ?? [])];
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
            this._hooks.post({ type: 'agentEvent', event: safeSerialize(event) });

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
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;

        switch (msg.type) {
            case 'prompt': {
                if (tab.isStreaming) {
                    console.log('[Pi] prompt rejected: tab is streaming');
                    throw new Error('Agent is still processing. Please wait or queue your message.');
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
                        this._hooks.post({ type: 'error', message });
                        break;
                    }
                    // The model may have been switched after the images were attached.
                    if (!tab.session.supportsImages()) {
                        this._hooks.post({ type: 'error', message: t('image.unsupported') });
                        break;
                    }
                    images = prepared.images;
                }
                let text = msg.text;
                if (msg.mentions && msg.mentions.length > 0) {
                    const resolved = await this._expandMentions(text, msg.mentions);
                    if (resolved.invalid.length > 0) {
                        this._hooks.post({
                            type: 'error',
                            message: t('mention.deleted', { path: resolved.invalid.join(', ') }),
                        });
                    }
                    // Nothing left after stripping dead refs and no images:
                    // skip the turn entirely.
                    if (!resolved.text.trim() && !(images && images.length > 0)) {
                        break;
                    }
                    text = resolved.text;
                }
                // Mention expansion awaits fs I/O; the streaming state may have
                // flipped during it. Re-check to avoid two concurrent turns.
                if (tab.isStreaming) {
                    throw new Error('Agent is still processing. Please wait or queue your message.');
                }
                if (tab.plan.machine.snapshot().phase === 'planning') {
                    text = planningPrompt(text);
                }
                if (tab.checkpointManager.rollbackPoint !== null) {
                    tab.checkpointManager.discardSuspended();
                    tab.diffManager.discardSuspended();
                    tab.suspendedMessages = [];
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
                break;
            }
            case 'steer':
                await tab.session.steer(msg.text);
                break;
            case 'queueMessage':
                await tab.session.followUp(msg.text);
                tab.queuedMessages = tab.session.getFollowUpMessages();
                this._emitStateChange();
                break;
            case 'editQueuedMessage':
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
                await tab.session.followUp(msg.text);
                break;
            case 'abort': {
                const planPhase = tab.plan.machine.snapshot().phase;
                if (planPhase === 'executing') {
                    tab.plan.runId++;
                    tab.plan.machine.interrupt();
                    // Drop dangling approval cards, as planAbandon does.
                    const danglingIds = [...tab.pendingApprovals.keys()];
                    for (const id of danglingIds) {
                        this._resolveToolApproval(tab, id, false);
                    }
                    this._emitStateChange();
                } else if (planPhase === 'planning') {
                    tab.plan.abortSeen = true;
                }
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
                tab.diffManager.clearAll();
                tab.checkpointManager.clearAll();
                tab.turnCounter = 0;
                this._resetStreaming(tab);
                tab.messageMeta.clear();
                tab.suspendedMessages = [];
                tab.queuedMessages = [];
                tab.compactionStage = 'none';
                tab.compactionPrompt = null;
                this._resetPlan(tab);
                tab.name = 'New Agent';
                this._emitStateChange();
                break;
            case 'loadSession':
                await tab.session.loadSession(msg.sessionPath);
                tab.diffManager.clearAll();
                tab.checkpointManager.clearAll();
                tab.suspendedMessages = [];
                tab.queuedMessages = [];
                tab.compactionStage = 'none';
                tab.compactionPrompt = null;
                this._resetStreaming(tab);
                tab.messageMeta.clear();
                this._resetPlan(tab);
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
                    tab.diffManager.clearAll();
                    tab.checkpointManager.clearAll();
                    tab.suspendedMessages = [];
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
                this._hooks.post({ type: 'sessions', sessions, currentSessionId: currentId });
                break;
            }
            case 'getSessions': {
                const sessions = await tab.session.getSessions();
                const currentId = tab.session.getSessionId();
                this._hooks.post({ type: 'sessions', sessions, currentSessionId: currentId });
                break;
            }
            case 'refreshConfig': {
                const config = await refreshPiConfig(this._hooks.getCwd());
                this._hooks.post({ type: 'configState', config });
                break;
            }
            case 'applyPreview': {
                try {
                    const preview = await this._hooks.applyPreview(msg.code, msg.lang, tab.id);
                    if (preview) {
                        this._hooks.post({ type: 'applyPreviewResult', preview });
                    }
                } catch (err: any) {
                    this._hooks.post({
                        type: 'applyResult',
                        previewId: '',
                        ok: false,
                        message: err?.message ?? String(err),
                    });
                }
                break;
            }
            case 'applyConfirm': {
                const result = await this._hooks.applyConfirm(msg.previewId);
                this._hooks.post({
                    type: 'applyResult',
                    previewId: msg.previewId,
                    ok: result.ok,
                    message: result.message,
                });
                break;
            }
            case 'applyCancel':
                this._hooks.applyCancel(msg.previewId);
                break;
            case 'compactionAccept': {
                if (tab.compactionInFlight) break;
                tab.compactionInFlight = true;
                try {
                    await tab.session.compact();
                    tab.compactionInFlight = false;
                    tab.compactionPrompt = null;
                    // stateSync first: the banner must clear before the result
                    // lands, or the live buttons linger for one tick.
                    this._emitStateChange();
                    this._hooks.post({ type: 'compactionResult', ok: true });
                } catch {
                    // Keep the stage: a failed compact still gets the 90% re-prompt.
                    tab.compactionInFlight = false;
                    tab.compactionPrompt = null;
                    this._emitStateChange();
                    this._hooks.post({ type: 'compactionResult', ok: false });
                }
                break;
            }
            case 'compactionDismiss':
                tab.compactionPrompt = null;
                this._emitStateChange();
                break;
            case 'mentionQuery': {
                const [files, symbols] = await Promise.all([
                    this._hooks.searchFiles(msg.query),
                    this._hooks.searchSymbols(msg.query),
                ]);
                this._hooks.post({ type: 'mentionResults', requestId: msg.requestId, files, symbols });
                break;
            }
            case 'dropFiles': {
                const results = await this._hooks.resolveDroppedFiles(msg.uris);
                this._hooks.post({ type: 'dropResolved', requestId: msg.requestId, results });
                break;
            }
            case 'planStart': {
                if (tab.isStreaming) {
                    throw new Error('Agent is still processing. Please wait or queue your message.');
                }
                const phase = tab.plan.machine.snapshot().phase;
                if (phase === 'interrupted') {
                    tab.plan.machine.restartPlanning();
                } else if (!tab.plan.machine.startPlanning()) {
                    break;
                }
                tab.plan.capturedSteps = null;
                this._restrictPlanTools(tab);
                this._emitStateChange();
                break;
            }
            case 'planCancel':
                if (tab.plan.machine.cancel()) {
                    this._restorePlanTools(tab);
                    this._emitStateChange();
                }
                break;
            case 'planApprove': {
                if (tab.isStreaming) {
                    throw new Error('Agent is still processing. Please wait or queue your message.');
                }
                if (tab.plan.machine.approve()) {
                    this._emitStateChange();
                    void this._runPlanSteps(tab);
                }
                break;
            }
            case 'planReplan': {
                if (tab.isStreaming) {
                    throw new Error('Agent is still processing. Please wait or queue your message.');
                }
                if (!tab.plan.machine.replan()) break;
                tab.plan.capturedSteps = null;
                this._restrictPlanTools(tab);
                this._emitStateChange();
                await tab.session.prompt(replanPrompt(msg.feedback));
                break;
            }
            case 'planSetSteps':
                if (tab.plan.machine.setSteps(msg.titles)) {
                    this._emitStateChange();
                }
                break;
            case 'planAdjust':
                if (tab.plan.machine.adjust(msg.titles)) {
                    this._emitStateChange();
                }
                break;
            case 'planResume': {
                if (tab.isStreaming) {
                    throw new Error('Agent is still processing. Please wait or queue your message.');
                }
                if (tab.plan.machine.resume()) {
                    this._emitStateChange();
                    void this._runPlanSteps(tab);
                }
                break;
            }
            case 'planAbandon': {
                if (!tab.plan.machine.abandon()) break;
                tab.plan.runId++;
                // Drop any dangling approval card so its promise cannot leak.
                const danglingIds = [...tab.pendingApprovals.keys()];
                for (const id of danglingIds) {
                    this._resolveToolApproval(tab, id, false);
                }
                this._emitStateChange();
                if (tab.isStreaming) {
                    await tab.session.abort();
                }
                break;
            }
            case 'planClose':
                if (tab.plan.machine.close()) {
                    this._restorePlanTools(tab);
                    this._emitStateChange();
                }
                break;
            case 'getState':
                this._hooks.post({ type: 'stateSync', state: this.getState() });
                break;
            case 'getSkills': {
                const skills = tab.session.getSkills();
                const commands = tab.session.getCommands();
                this._hooks.post({ type: 'skills', skills, commands });
                break;
            }
            case 'approveToolCall':
                this._resolveToolApproval(tab, msg.toolCallId, true);
                this._maybeResumeAfterPlanCard(tab);
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
                    this._hooks.post({
                        type: 'approvalTrace',
                        toolCallId: msg.toolCallId,
                        toolName,
                        scope,
                    });
                }
                this._resolveToolApproval(tab, msg.toolCallId, true);
                this._maybeResumeAfterPlanCard(tab);
                break;
            }
            case 'openFile':
                this._hooks.openFile(msg.filePath);
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

                if (redone.length > 0) {
                    this._hooks.showMessage(`Re-applied ${redone.length} file(s).`);
                }
                this._emitStateChange();
                break;
            }
            case 'confirmAction': {
                const confirmed = await this._hooks.confirmDialog(msg.message);
                this._hooks.post({
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
                this._hooks.openSettings();
                break;
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
        const planSnap = tab.plan.machine.snapshot();
        if (planSnap.phase === 'executing' && PLAN_CREDENTIAL_TOOLS.includes(toolName) && !isDangerousTool(toolName)) {
            // 计划批准凭据：计划内非危险核心工具放行，留痕来源 = Plan。
            if (tab.id === this._activeTabId) {
                this._hooks.post({
                    type: 'approvalTrace',
                    toolCallId,
                    toolName,
                    scope: 'session',
                    source: 'plan',
                });
            }
            return Promise.resolve(true);
        }
        if (planSnap.phase === 'executing' && isDangerousTool(toolName) && planSnap.currentStep >= 0) {
            // 危险工具例外：弹卡并让当前步骤进入失败暂停态（PRD 9.5）。
            tab.plan.machine.fail(planSnap.currentStep, PLAN_DANGEROUS_REASON);
            this._emitStateChange();
        }

        const decision = tab.approvalMemory.check(toolName);
        if (decision.approved) {
            if (tab.id === this._activeTabId) {
                this._hooks.post({
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
                this._hooks.post({
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
                this._hooks.post({ type: 'toolCallResolved', toolCallId });
            }
        }
    }

    // ── Plan mode glue (PRD C8/C9) ──

    private _restrictPlanTools(tab: any): void {
        if (tab.plan.savedTools !== null) return;
        const active = tab.session.getActiveToolNames();
        tab.plan.savedTools = active;
        tab.session.setActiveToolsByName(active.filter((n: string) => PLAN_READONLY_TOOLS.includes(n)));
    }

    private _restorePlanTools(tab: any): void {
        if (tab.plan.savedTools === null) return;
        const saved = tab.plan.savedTools;
        tab.plan.savedTools = null;
        tab.session.setActiveToolsByName(saved);
    }

    private _resetPlan(tab: any): void {
        this._restorePlanTools(tab);
        tab.plan = {
            machine: new PlanMachine(),
            savedTools: null,
            // Monotonic: a zombie driver from the disposed runtime must see a
            // runId mismatch and exit instead of touching the fresh plan.
            runId: tab.plan.runId + 1,
            driverActive: false,
            abortSeen: false,
            capturedSteps: null,
        };
    }

    /**
     * On approval-card resolution, a plan paused on the dangerous-tool card
     * resumes the current step (批准后从当前步继续). While the paused turn is
     * still streaming the live driver picks the resumed state up; otherwise a
     * fresh driver retries the step.
     */
    private _maybeResumeAfterPlanCard(tab: any): void {
        const snap = tab.plan.machine.snapshot();
        if (snap.phase !== 'paused' || snap.pausedReason !== PLAN_DANGEROUS_REASON) return;
        if (tab.pendingApprovals.size > 0) return;
        if (tab.plan.machine.resume()) {
            this._emitStateChange();
            void this._runPlanSteps(tab);
        }
    }

    /** Extract plain text from an SDK assistant message (content blocks or raw). */
    private _assistantText(msg: any): string {
        const content = msg?.content;
        return Array.isArray(content)
            ? content
                  .filter((p: any) => p?.type === 'text')
                  .map((p: any) => p?.text ?? '')
                  .join('\n')
            : String(content ?? '');
    }

    /**
     * Finish a planning turn: prefer the plan captured from the planning
     * turn's own message_end (a queued follow-up may drain inside the same
     * run, making settle-time last-message parsing unreliable), falling back
     * to the last assistant message. Success moves the machine to 待批准 and
     * restores the toolset; failure keeps 规划中 (with an error unless the
     * user aborted the turn).
     */
    private _maybeFinishPlanning(tab: any): void {
        if (tab.plan.machine.snapshot().phase !== 'planning') return;
        const wasAborted = tab.plan.abortSeen;
        tab.plan.abortSeen = false;

        let titles = tab.plan.capturedSteps ?? [];
        tab.plan.capturedSteps = null;
        if (titles.length === 0) {
            const msgs = tab.session.getMessages();
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i]?.role === 'assistant') {
                    titles = parsePlanBlock(this._assistantText(msgs[i]));
                    break;
                }
            }
        }

        if (titles.length > 0 && tab.plan.machine.planProduced(titles)) {
            this._restorePlanTools(tab);
            this._emitStateChange();
            return;
        }
        if (!wasAborted && tab.id === this._activeTabId) {
            this._hooks.post({ type: 'error', message: t('plan.noPlan') });
        }
        this._emitStateChange();
    }

    /**
     * Sequential per-step executor: one agent turn per plan step. Single-flight
     * per tab (a live driver picks up resumed state); invalidated by runId on
     * interrupt/abandon.
     */
    private async _runPlanSteps(tab: any): Promise<void> {
        if (tab.plan.driverActive) return;
        tab.plan.driverActive = true;
        const runId = tab.plan.runId;
        try {
            for (;;) {
                const snap = tab.plan.machine.snapshot();
                if (snap.phase !== 'executing' || runId !== tab.plan.runId) return;
                const idx = snap.steps.findIndex((s: any) => s.status !== 'done' && s.status !== 'cancelled');
                if (idx < 0) return;
                const total = snap.steps.length;
                if (!tab.plan.machine.stepStarted(idx)) return;
                this._emitStateChange();
                try {
                    await tab.session.prompt(stepPrompt(snap.steps[idx].title, idx, total));
                } catch (err: any) {
                    if (runId !== tab.plan.runId) return;
                    tab.plan.machine.fail(idx, String(err?.message ?? err));
                    this._emitStateChange();
                    return;
                }
                if (runId !== tab.plan.runId) return;
                if (tab.plan.machine.snapshot().phase !== 'executing') return;
                tab.plan.machine.stepDone(idx);
                this._emitStateChange();
            }
        } finally {
            tab.plan.driverActive = false;
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
        await tab.session.dispose();
        this._tabs.delete(tabId);

        if (wasActive) {
            this._activeTabId = this._tabs.keys().next().value!;
        }

        this._emitStateChange();
    }

    private _switchTab(tabId: string): void {
        if (!this._tabs.has(tabId) || tabId === this._activeTabId) return;

        this._activeTabId = tabId;

        const tab = this._tabs.get(tabId)!;
        tab.hasNotification = false;
        this._hooks.setContext('pi-agent.isStreaming', tab.isStreaming);

        this._emitStateChange();
    }

    private _findCutoffIndex(messages: any[], rollbackPoint: number): number {
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

    async newSession(): Promise<void> {
        await this.dispatch({ type: 'newSession' });
    }

    async abort(): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (tab) await tab.session.abort();
    }

    async selectModel(): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        await tab.session.showModelPicker();
        this._emitStateChange();
    }

    toggleThinking(): string | undefined {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return undefined;
        const level = tab.session.cycleThinkingLevel();
        this._emitStateChange();
        return level;
    }

    async compact(): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        await tab.session.compact();
        this._emitStateChange();
    }

    /** Host entry (editor context menu): prompt, or FollowUp queue while streaming. */
    async sendToPi(text: string): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        if (tab.isStreaming) {
            await this.dispatch({ type: 'queueMessage', text });
        } else {
            await this.dispatch({ type: 'prompt', text });
        }
    }

    dispose(): void {
        for (const [, unsubs] of this._tabSubscriptions) {
            for (const unsub of unsubs) unsub();
        }
        this._tabSubscriptions.clear();
        for (const tab of this._tabs.values()) {
            tab.diffManager.dispose();
            tab.checkpointManager.dispose();
        }
        this._tabs.clear();
        this._stateListeners = [];
    }
}
