import type { PiSessionManager } from '../pi/session';
import type {
    ClientMessage,
    ServerMessage,
    SerializedAgentState,
    TabInfo,
} from '../shared/protocol';
import { DiffManager } from './diff';
import { CheckpointManager } from './checkpoint';

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
}

interface PendingApproval {
    resolve: (approved: boolean) => void;
}

interface MessageMeta {
    thinkingDurationSec: number;
    messageEndTime: number;
}

let tabIdCounter = 0;
function nextTabId(): string {
    return `tab-${++tabIdCounter}`;
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
        queuedMessages: string[];
        isStreaming: boolean;
    }>();
    private _activeTabId = '';
    private _tabSubscriptions = new Map<string, (() => void)[]>();
    private _stateListeners: (() => void)[] = [];

    constructor(
        private _factory: TabFactory,
        private _hooks: TabManagerHooks,
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
            queuedMessages: [],
            isStreaming: false,
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
        for (const listener of this._stateListeners) listener();
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
        }

        if (event.type === 'agent_end') {
            tab.isStreaming = false;
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
            tab.thinkingStartTime = 0;
            tab.streamingThinkingDuration = 0;
            tab.agentStartTime = 0;
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
        const sessionName = tab.session.session?.sessionName;
        if (sessionName && tab.name !== sessionName) {
            tab.name = sessionName;
        }
    }

    async dispatch(msg: ClientMessage): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;

        switch (msg.type) {
            case 'prompt': {
                if (tab.checkpointManager.rollbackPoint !== null) {
                    tab.checkpointManager.discardSuspended();
                    tab.diffManager.discardSuspended();
                    tab.suspendedMessages = [];
                }
                tab.turnCounter++;
                const turnIdx = tab.turnCounter;
                tab.checkpointManager.startTurn(turnIdx);
                tab.diffManager.setCurrentTurn(turnIdx);
                await tab.session.prompt(msg.text);
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
            case 'abort':
                await tab.session.abort();
                break;
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
                tab.name = 'New Agent';
                this._emitStateChange();
                break;
            case 'loadSession':
                await tab.session.loadSession(msg.sessionPath);
                tab.diffManager.clearAll();
                tab.checkpointManager.clearAll();
                tab.suspendedMessages = [];
                tab.queuedMessages = [];
                this._resetStreaming(tab);
                tab.messageMeta.clear();
                this._updateTabName(tab);
                this._emitStateChange();
                break;
            case 'getSessions': {
                const sessions = await tab.session.getSessions();
                const currentId = tab.session.session?.sessionId;
                this._hooks.post({ type: 'sessions', sessions, currentSessionId: currentId });
                break;
            }
            case 'getState':
                this._hooks.post({ type: 'stateSync', state: this.getState() });
                break;
            case 'getSkills': {
                const skills = tab.session.getSkills();
                this._hooks.post({ type: 'skills', skills });
                break;
            }
            case 'approveToolCall':
                this._resolveToolApproval(tab, msg.toolCallId, true);
                break;
            case 'rejectToolCall':
                this._resolveToolApproval(tab, msg.toolCallId, false);
                break;
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
            case 'restoreCheckpoint': {
                const restored = await tab.checkpointManager.restoreCheckpoint(msg.messageIndex);
                tab.diffManager.suspendChangesAfter(msg.messageIndex);

                const allMsgs = tab.session.getMessages();
                const cutoff = this._findCutoffIndex(allMsgs, msg.messageIndex);
                if (cutoff >= 0 && cutoff < allMsgs.length) {
                    tab.suspendedMessages = allMsgs.slice(cutoff);
                    tab.session.setMessages(allMsgs.slice(0, cutoff));
                }

                if (restored.length > 0) {
                    this._hooks.showMessage(
                        `Restored ${restored.length} file(s) to checkpoint.`,
                    );
                }
                this._emitStateChange();
                break;
            }
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

    private _resetStreaming(tab: any): void {
        tab.isStreaming = false;
        tab.streamingText = '';
        tab.streamingThinking = '';
        tab.isThinking = false;
        tab.thinkingStartTime = 0;
        tab.streamingThinkingDuration = 0;
        tab.agentStartTime = 0;
    }

    private _requestToolApproval(tab: any, toolCallId: string, toolName: string, args: any): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            tab.pendingApprovals.set(toolCallId, { resolve });

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
