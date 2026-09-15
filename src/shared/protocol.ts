export interface ContextUsageInfo {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}

export interface SettingsData {
    apiProvider: string;
    apiKeySet: boolean;
    authMethod: 'env' | 'pi-login' | 'manual' | 'none';
    defaultModel: string;
    thinkingLevel: string;
    autoApproveTools: boolean;
    allowedTools: string[];
    autoSaveSessions: boolean;
    sessionStoragePath: string;
    contextUsageWarningThreshold: number;
}

export interface ToolCallPendingInfo {
    toolCallId: string;
    toolName: string;
    args: any;
}

export type ApprovalScope = 'session' | 'global';

export type Lang = 'en' | 'zh';

/** Diff preview for applying a chat code block to a file (PRD C3). */
export interface ApplyPreviewInfo {
    previewId: string;
    targetPath: string;
    isNew: boolean;
    diff: string;
    addedLines: number;
    removedLines: number;
    code: string;
}

export interface ApprovalRuleInfo {
    tool: string;
    createdAt: number;
}

export interface FileChangeInfo {
    filePath: string;
    toolCallId: string;
    toolName: string;
    isNew: boolean;
    diff?: string;
    addedLines: number;
    removedLines: number;
    turnIndex: number;
}

export interface TabInfo {
    id: string;
    name: string;
    isActive: boolean;
    isStreaming: boolean;
    hasNotification: boolean;
}

export interface SerializedAgentState {
    messages: any[];
    model?: { provider: string; id: string; name?: string };
    thinkingLevel?: string;
    isStreaming: boolean;
    streamingMessage?: any;
    errorMessage?: string;
    tools: string[];
    sessionId?: string;
    sessionName?: string;
    contextUsage?: ContextUsageInfo;
    fileChanges?: FileChangeInfo[];
    rollbackPoint?: number | null;
    tabs?: TabInfo[];
    activeTabId?: string;
    streamingText?: string;
    streamingThinking?: string;
    isThinking?: boolean;
    thinkingStartTime?: number;
    streamingThinkingDuration?: number;
    queuedMessages?: string[];
    compactionPrompt?: number | null;
    supportsImages?: boolean;
}

export interface ModelInfo {
    provider: string;
    id: string;
    name?: string;
    supportsImages?: boolean;
}

export interface SkillInfo {
    name: string;
    description: string;
    filePath: string;
    source: string;
    disableModelInvocation: boolean;
}

export interface CommandInfo {
    name: string;
    description: string;
    source: 'extension' | 'builtin' | 'skill' | 'prompt';
    /** Display label for slash menu (e.g. "/skill:name" or "/tree"). Falls back to "/{name}". */
    label?: string;
}

export interface SessionInfo {
    id: string;
    name?: string;
    path: string;
    lastModified?: number;
}

export type ConfigStatus = 'not-found' | 'ok' | 'partial' | 'error';

export type ConfigSource = 'agentDir' | 'models' | 'skills';

export interface ConfigIssue {
    source: ConfigSource;
    message: string;
}

/** Read-only discovery of the user's Pi configuration (~/.pi/agent). */
export interface PiConfigSnapshot {
    status: ConfigStatus;
    agentDir: string;
    agentDirExists: boolean;
    providers: string[];
    models: ModelInfo[];
    skills: SkillInfo[];
    errors: ConfigIssue[];
    discoveredAt: number;
}

// Webview -> Extension messages
export type ClientMessage =
    | { type: 'prompt'; text: string; images?: string[]; mentions?: string[] }
    | { type: 'steer'; text: string }
    | { type: 'followUp'; text: string }
    | { type: 'abort' }
    | { type: 'getModels' }
    | { type: 'setModel'; provider: string; modelId: string }
    | { type: 'setThinkingLevel'; level: string }
    | { type: 'newSession' }
    | { type: 'loadSession'; sessionPath: string }
    | { type: 'renameSession'; name: string; sessionPath?: string }
    | { type: 'getSessions' }
    | { type: 'getState' }
    | { type: 'approveToolCall'; toolCallId: string }
    | { type: 'rejectToolCall'; toolCallId: string }
    | { type: 'rememberToolApproval'; toolCallId: string; scope: ApprovalScope }
    | { type: 'openFile'; filePath: string }
    | { type: 'openDiff'; filePath: string; toolCallId: string }
    | { type: 'undoFileChange'; filePath: string; toolCallId: string }
    | { type: 'restoreCheckpoint'; messageIndex: number }
    | { type: 'redoCheckpoint' }
    | { type: 'confirmAction'; action: string; message: string; payload?: any }
    | { type: 'createTab' }
    | { type: 'closeTab'; tabId: string }
    | { type: 'switchTab'; tabId: string }
    | { type: 'openSettings' }
    | { type: 'getSkills' }
    | { type: 'queueMessage'; text: string }
    | { type: 'editQueuedMessage'; index: number; text: string }
    | { type: 'removeQueuedMessage'; index: number }
    | { type: 'cancelQueue' }
    | { type: 'refreshConfig' }
    | { type: 'applyPreview'; code: string; lang: string }
    | { type: 'applyConfirm'; previewId: string }
    | { type: 'applyCancel'; previewId: string }
    | { type: 'compactionAccept' }
    | { type: 'compactionDismiss' }
    | { type: 'mentionQuery'; query: string; requestId: number };

// Settings webview -> Extension messages
export type SettingsClientMessage =
    | { type: 'getSettings' }
    | { type: 'updateSetting'; key: string; value: any }
    | { type: 'setApiKey'; provider: string; key: string }
    | { type: 'clearApiKey'; provider: string }
    | { type: 'getSkills' }
    | { type: 'getApprovalRules' }
    | { type: 'revokeApprovalRule'; tool: string }
    | { type: 'clearApprovalRules' };

// Extension -> Webview messages
export interface MentionSymbolItem {
    name: string;
    kind: string;
    path: string;
    line: number;
}

export type ServerMessage =
    | { type: 'ready' }
    | { type: 'stateSync'; state: SerializedAgentState }
    | { type: 'agentEvent'; event: any }
    | { type: 'models'; models: ModelInfo[]; current?: ModelInfo; thinkingLevel?: string; availableThinkingLevels?: string[]; supportsThinking?: boolean }
    | { type: 'modelChanged'; model: ModelInfo; thinkingLevel?: string }
    | { type: 'sessions'; sessions: SessionInfo[]; currentSessionId?: string }
    | { type: 'sessionChanged'; sessionId: string }
    | { type: 'fileChange'; change: FileChangeInfo }
    | { type: 'confirmResult'; action: string; confirmed: boolean; payload?: any }
    | { type: 'toolCallPending'; pending: ToolCallPendingInfo }
    | { type: 'toolCallResolved'; toolCallId: string }
    | { type: 'approvalTrace'; toolCallId: string; toolName: string; scope: ApprovalScope }
    | { type: 'skills'; skills: SkillInfo[]; commands?: CommandInfo[] }
    | { type: 'configState'; config: PiConfigSnapshot }
    | { type: 'langChanged'; lang: Lang }
    | { type: 'applyPreviewResult'; preview: ApplyPreviewInfo }
    | { type: 'applyResult'; previewId: string; ok: boolean; message?: string }
    | { type: 'compactionResult'; ok: boolean }
    | { type: 'mentionResults'; requestId: number; files: string[]; symbols: MentionSymbolItem[] }
    | { type: 'error'; message: string };

// Extension -> Settings webview messages
export type SettingsServerMessage =
    | { type: 'settings'; data: SettingsData }
    | { type: 'settingChanged'; key: string; value: any }
    | { type: 'skills'; skills: SkillInfo[] }
    | { type: 'approvalRules'; rules: ApprovalRuleInfo[] }
    | { type: 'langChanged'; lang: Lang }
    | { type: 'error'; message: string };
