import type { ClientMessage, ServerMessage, SerializedAgentState, FileChangeInfo, TabInfo, ToolCallPendingInfo, SkillInfo, CommandInfo, PiConfigSnapshot, ApprovalScope, ApplyPreviewInfo, Lang, MentionSymbolItem, SessionOccupancy, SelectionContextInfo } from '../shared/protocol';
import { buildOccupancyBannerHtml } from './render/occupancy';
import { MAX_IMAGES_PER_PROMPT, MAX_IMAGE_BYTES } from '../shared/image-input';
import { normalizeImageFile } from './image-resize';
import { matchesModelFilter } from '../shared/model-filter';
import { rankSlashMenuItems } from '../shared/slash-commands';
import { t, setLang, type TextKey } from '../shared/i18n';
import { hasMentionToken } from '../shared/mention';
import { parseUriList } from '../shared/drop-files';
import { escAttr, formatTokenCount, truncate, tryParseJSON, extractToolResultText, getToolLabel, extractText } from '../shared/webview-text';
import { looksBinary, normalizeAttachContent, MAX_ATTACH_FILE_BYTES, type AttachFileEntry } from '../shared/attach';
import { el, escHtml } from './dom';
import { showToast } from './toast';
import { buildWelcome, buildThinkingBlock, buildDiffCard, buildToolCardHeader, buildMessageTree, buildToolApprovalCard, buildApplyPreviewCard, buildChangedFilesSection, buildConfigBanner, applyMemoryBadge, resetCodeBlockIds, buildModelItem, buildStreamingSkeleton, updateStreamingThinking, reconcileStreamingText, prepareMarkdown } from './render/messages';

declare function acquireVsCodeApi(): {
    postMessage(message: ClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();
// ── State ──

const state: {
    messages: any[];
    isStreaming: boolean;
    model?: { provider: string; id: string; name?: string };
    thinkingLevel?: string;
    availableThinkingLevels?: string[];
    supportsThinking?: boolean;
    tools: string[];
    sessionId?: string;
    sessionName?: string;
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    thinkingStartTime: number;
    streamingThinkingDuration: number;
    contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
    fileChanges: FileChangeInfo[];
    rollbackPoint: number | null;
    availableModels: any[];
    recentModels: { provider: string; id: string; name?: string }[];
    tabs: TabInfo[];
    activeTabId: string;
    skills: SkillInfo[];
    commands: CommandInfo[];
    queuedMessages: string[];
    config?: PiConfigSnapshot;
    approvalTraces: Map<string, ApprovalScope>;
    pendingApprovals: ToolCallPendingInfo[];
    applyPreviews: ApplyPreviewInfo[];
    compactionPrompt: number | null;
    compactionBusy: boolean;
    pendingImages: string[];
    pendingAttachments: AttachFileEntry[];
    supportsImages: boolean;
    mentions: string[];
    selection: SelectionContextInfo | null;
    occupancy: SessionOccupancy | null;
    /** assetId → dataUrl, fed by stateSync.images (T16 image separation). */
    imageCache: Record<string, string>;
} = {
    messages: [],
    isStreaming: false,
    tools: [],
    streamingText: '',
    streamingThinking: '',
    isThinking: false,
    thinkingStartTime: 0,
    streamingThinkingDuration: 0,
    availableModels: [],
    recentModels: [],
    fileChanges: [],
    rollbackPoint: null,
    tabs: [],
    activeTabId: '',
    skills: [],
    commands: [],
    queuedMessages: [],
    approvalTraces: new Map<string, ApprovalScope>(),
    pendingApprovals: [],
    applyPreviews: [],
    compactionPrompt: null,
    compactionBusy: false,
    pendingImages: [],
    pendingAttachments: [],
    supportsImages: false,
    mentions: [],
    selection: null,
    occupancy: null,
    imageCache: {},
};

let sessionSearchQuery = '';

// ── Message handling ──

window.addEventListener('message', (event) => {
    handleMessage(event.data as ServerMessage);
});

function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
        case 'ready':
            // Liveness signal only — the getState/getSkills handshake runs at
            // script init (bottom of file), so re-issuing it here would just
            // double the full-snapshot cost on every panel open.
            break;
        case 'stateSync':
            if (msg.images) Object.assign(state.imageCache, msg.images);
            applyStateSync(msg.state);
            break;
        case 'selectionChanged':
            state.selection = msg.selection;
            updateSelectionChip();
            break;
        case 'agentEvent':
            handleAgentEvent(msg.event);
            break;
        case 'models':
            state.availableModels = msg.models ?? [];
            state.availableThinkingLevels = msg.availableThinkingLevels ?? [];
            state.supportsThinking = msg.supportsThinking ?? false;
            if (msg.current) {
                state.model = msg.current;
                addToRecentModels(msg.current.provider, msg.current.id, msg.current.name);
            }
            if (msg.thinkingLevel) state.thinkingLevel = msg.thinkingLevel;
            updateFooterModel();
            if (pendingModelPicker) {
                pendingModelPicker = false;
                showModelPicker();
            }
            break;
        case 'modelChanged':
            // Follow-up/steer model switches arrive without a full 'models'
            // snapshot; keep the footer consumer (composer picker label,
            // approval card) in sync with the running turn.
            state.model = msg.model;
            if (msg.thinkingLevel) state.thinkingLevel = msg.thinkingLevel;
            updateFooterModel();
            break;
        case 'sessions':
            renderSessionList(msg.sessions, msg.currentSessionId);
            break;
        case 'fileChange':
            state.fileChanges.push(msg.change);
            renderChangedFilesBar();
            renderInlineFileChange(msg.change);
            break;
        case 'confirmResult':
            handleConfirmResult(msg.action, msg.confirmed, msg.payload);
            break;
        case 'toolCallPending':
            renderToolApprovalCard(msg.pending);
            break;
        case 'toolCallResolved':
            removeToolApprovalCard(msg.toolCallId);
            break;
        case 'approvalTrace': {
            const traces = state.approvalTraces;
            if (traces.size >= 200) {
                const oldest = traces.keys().next().value;
                if (oldest !== undefined) traces.delete(oldest);
            }
            traces.set(msg.toolCallId, msg.scope);
            applyMemoryBadge(document.getElementById(`tool-${msg.toolCallId}`) as HTMLElement | null, msg.toolCallId, state.approvalTraces);
            break;
        }
        case 'skills':
            state.skills = msg.skills;
            state.commands = msg.commands ?? [];
            break;
        case 'configState':
            state.config = msg.config;
            updateStatusChip();
            if (document.getElementById('model-picker')) {
                showModelPicker();
            }
            break;
        case 'langChanged': {
            setLang(msg.lang);
            closeModelPicker();
            const input = document.getElementById('input') as HTMLTextAreaElement | null;
            const draft = input?.value ?? '';
            render();
            if (input && draft) input.value = draft;
            for (const pending of state.pendingApprovals) {
                renderToolApprovalCard(pending);
            }
            for (const preview of state.applyPreviews) {
                renderApplyPreviewCard(preview);
            }
            if (state.isStreaming) {
                ensurePreparingPlaceholder();
            }
            renderStreamingContent();
            break;
        }
        case 'applyPreviewResult':
            renderApplyPreviewCard(msg.preview);
            break;
        case 'applyResult': {
            removeApplyPreviewCard(msg.previewId);
            if (msg.message) {
                if (msg.ok) {
                    showNotice(msg.message);
                } else {
                    showError(msg.message);
                }
            }
            break;
        }
        case 'compactionResult':
            state.compactionBusy = false;
            if (!msg.ok) {
                showError(msg.message ?? t('compact.failed'));
            }
            updateCompactionBanner();
            break;
        case 'mentionResults':
            if (msg.requestId !== mentionPendingRequestId) break;
            mentionFiles = msg.files;
            mentionSymbols = msg.symbols;
            {
                const input = document.getElementById('input') as HTMLTextAreaElement | null;
                if (input && getMentionFragment(input)) renderMentionMenu();
            }
            break;
        case 'dropResolved':
            if (msg.requestId !== dropPendingRequestId) break;
            dropPendingRequestId = -1;
            {
                let invalid = 0;
                for (const result of msg.results) {
                    if (result.status === 'file' && result.path) {
                        insertMentionTokenAtCursor(result.path);
                    } else if (result.status === 'invalid') {
                        invalid++;
                    }
                }
                if (invalid > 0) showError(t('mention.dropInvalid'));
            }
            break;
        case 'error':
            // A failed dispatch (e.g. corrupt session file) may mean the frame
            // a pending replace-marker waits for never arrives; drop it so a
            // later unrelated frame can't yank the view to the bottom.
            historyReplacePending = null;
            showError(msg.message);
            break;
    }
}

function handleConfirmResult(action: string, confirmed: boolean, payload?: any): void {
    if (!confirmed) return;
    switch (action) {
        case 'restoreCheckpoint':
            if (payload?.messageIndex !== undefined) {
                historyReplacePending = { from: state.sessionId, rewrite: true };
                vscode.postMessage({ type: 'restoreCheckpoint', messageIndex: payload.messageIndex });
            }
            break;
        case 'redoCheckpoint':
            historyReplacePending = { from: state.sessionId, rewrite: true };
            vscode.postMessage({ type: 'redoCheckpoint' });
            break;
    }
}

// Set when the webview initiates something that replaces the whole message
// history (load/restore/redo/startup getState): the resolving stateSync must
// land the view on the newest message. "load" resolves on a different session
// id only — a same-id frame may be an interim streaming frame, and scrolling
// it would yank the user; checkpoint rewrites and the startup getState never
// change the session, so they resolve on the first messages frame.
let historyReplacePending: { from: string | undefined; rewrite: boolean } | null = null;

// Turn currently being edited in the composer; null when not editing.
let editingTurn: number | null = null;

function applyStateSync(s: SerializedAgentState): void {
    const prevTab = state.activeTabId;
    // Unchanged message lists are omitted from the frame (T16); keep ours.
    state.messages = s.messages ?? state.messages;
    state.isStreaming = s.isStreaming;
    state.model = s.model;
    state.thinkingLevel = s.thinkingLevel;
    state.tools = s.tools ?? [];
    state.sessionId = s.sessionId;
    state.sessionName = s.sessionName;
    state.contextUsage = s.contextUsage;
    state.fileChanges = s.fileChanges ?? [];
    state.rollbackPoint = s.rollbackPoint ?? null;
    state.tabs = s.tabs ?? [];
    state.activeTabId = s.activeTabId ?? '';
    state.streamingText = s.streamingText ?? '';
    state.streamingThinking = s.streamingThinking ?? '';
    state.isThinking = s.isThinking ?? false;
    state.thinkingStartTime = s.thinkingStartTime ?? 0;
    state.streamingThinkingDuration = s.streamingThinkingDuration ?? 0;
    state.queuedMessages = s.queuedMessages ?? [];
    state.compactionPrompt = s.compactionPrompt ?? null;
    state.supportsImages = s.supportsImages ?? false;
    state.occupancy = s.occupancy ?? null;
    if (!state.supportsImages && state.pendingImages.length > 0) {
        // The model can switch under attached images; drop them rather than
        // delivering to a text-only model.
        state.pendingImages = [];
        updateImageChips();
    }
    const tabSwitched = prevTab !== state.activeTabId;

    // Transient cards live in the per-tab streaming area; they are wiped on a
    // tab switch and must not resurrect on a later langChanged.
    if (tabSwitched) {
        state.pendingApprovals = [];
        state.applyPreviews = [];
        state.compactionBusy = false;
        state.pendingImages = [];
        state.pendingAttachments = [];
        state.mentions = [];
        hideMentionMenu();
        dropPendingRequestId = -1;
        cancelEditMode({ keepDraft: true });
    }

    if (tabSwitched || !skeletonBuilt) {
        render();
        // Only a frame that actually carries the history can satisfy a
        // pending replace — a message-less tab frame (resolve-time read-mode
        // snapshots and T16-omitted unchanged messages both produce one) must
        // not consume it, or the full frame behind it lands unscrolled at the
        // top.
        if (s.messages !== undefined) historyReplacePending = null;
        userHasScrolled = false;
        scrollToBottom(true);
        updateScrollButton();
    } else {
        updateTabs();
        renderStreamingContent();
        updateMessages();
        if (historyReplacePending && s.messages !== undefined) {
            const { from, rewrite } = historyReplacePending;
            if (rewrite || s.sessionId !== from) {
                historyReplacePending = null;
                userHasScrolled = false;
                scrollToBottom(true);
                updateScrollButton();
            }
        }
        updateInputArea();
        updateChangedFiles();
        updateQueuedMessageBanner();
        updateCompactionBanner();
        updateImageChips();
        updateOccupancyBanner();
        if (state.isStreaming) {
            ensurePreparingPlaceholder();
        }
        updateScrollButton();
    }
}

function handleAgentEvent(event: any): void {
    switch (event.type) {
        case 'message_update':
            if (event.assistantMessageEvent) {
                handleStreamingDelta(event.assistantMessageEvent);
            }
            break;
        case 'agent_start':
            state.isStreaming = true;
            state.streamingText = '';
            state.streamingThinking = '';
            state.isThinking = false;
            userHasScrolled = false;
            updateInputArea();
            clearStreamingRegion();
            showPreparingPlaceholder();
            break;
        case 'agent_end':
            if (event.willRetry) {
                // SDK will retry — keep streaming UI active
                break;
            }
            // Don't clear isStreaming yet — wait for agent_settled
            clearStreamingState();
            dismissSteerToast();
            clearStreamingRegion();
            break;
        case 'auto_retry_start':
            showRetryPlaceholder(event.attempt, event.maxAttempts, event.delayMs, event.errorMessage);
            break;
        case 'auto_retry_end':
            removeRetryPlaceholder();
            break;
        case 'agent_settled':
            state.isStreaming = false;
            clearStreamingState();
            dismissSteerToast();
            removeRetryPlaceholder();
            clearStreamingRegion();
            updateInputArea();
            break;
        case 'tool_execution_start':
            removePreparingPlaceholder();
            renderToolStart(event);
            break;
        case 'tool_execution_update':
            renderToolUpdate(event);
            break;
        case 'tool_execution_end':
            renderToolEnd(event);
            showPreparingPlaceholder();
            break;
    }
}

function handleStreamingDelta(ae: any): void {
    switch (ae.type) {
        case 'thinking_start':
            state.isThinking = true;
            state.streamingThinking = '';
            state.thinkingStartTime = Date.now();
            state.streamingThinkingDuration = 0;
            break;
        case 'thinking_delta':
            state.streamingThinking += ae.delta ?? '';
            dismissSteerToast();
            break;
        case 'thinking_end':
            state.isThinking = false;
            if (state.thinkingStartTime > 0) {
                state.streamingThinkingDuration = Math.round((Date.now() - state.thinkingStartTime) / 1000);
            }
            break;
        case 'text_start':
            break;
        case 'text_delta':
            state.streamingText += ae.delta ?? '';
            dismissSteerToast();
            break;
        case 'text_end':
            break;
    }
    scheduleStreamingRender();
}

// ── Streaming render pipeline ──

// Deltas can arrive faster than frames — coalesce to one render per frame.
let streamRenderQueued = false;

function scheduleStreamingRender(): void {
    if (streamRenderQueued) return;
    streamRenderQueued = true;
    requestAnimationFrame(() => {
        streamRenderQueued = false;
        renderStreamingContent();
    });
}

// ── Rendering ──

let skeletonBuilt = false;

function render(): void {
    const app = document.getElementById('app')!;
    app.innerHTML = '';
    skeletonBuilt = false;

    // Header: brand row (mark + name + tabs) + rail row (status chip + actions)
    const header = el('div', 'header');
    const brandRow = el('div', 'brand-row');
    const brand = el('div', 'brand');
    brand.innerHTML = `<span class="brand-mark">&pi;</span><span class="brand-name">${escHtml(t('welcome.title'))}</span>`;
    brandRow.appendChild(brand);
    const tabStrip = el('div', 'tab-strip');
    brandRow.appendChild(tabStrip);
    header.appendChild(brandRow);
    const railRow = el('div', 'rail-row');
    const statusChip = el('span', 'status-chip');
    statusChip.id = 'status-chip';
    statusChip.innerHTML = '<span class="status-dot"></span><span class="status-label"></span>';
    railRow.appendChild(statusChip);
    const headerActions = el('div', 'header-right');
    headerActions.innerHTML = `
        <button class="icon-btn" id="btn-new-tab" title="${escHtml(t('header.newAgent'))}">
            <svg class="header-icon-svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M8 3v10M3 8h10"/>
            </svg>
        </button>
        <button class="icon-btn" id="btn-sessions" title="${escHtml(t('header.sessions'))}">
            <svg class="header-icon-svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M2 4h12M2 8h12M2 12h12"/>
            </svg>
        </button>
        <button class="icon-btn" id="btn-settings" title="${escHtml(t('header.settings'))}">
            <svg class="header-icon-svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>
                <path d="M7 1h2l.3 1.6a5.5 5.5 0 0 1 1.5.9l1.5-.5 1 1.7-1.2 1.1a5.5 5.5 0 0 1 .5 1.7L15 7v2l-1.4.7a5.5 5.5 0 0 1-.5 1.7l1.2 1.1-1 1.7-1.5-.5a5.5 5.5 0 0 1-1.5.9L9 15H7l-.3-1.6a5.5 5.5 0 0 1-1.5-.9l-1.5.5-1-1.7 1.2-1.1a5.5 5.5 0 0 1-.5-1.7L1 9V7l1.4-.7a5.5 5.5 0 0 1 .5-1.7L1.7 3.5l1-1.7 1.5.5a5.5 5.5 0 0 1 1.5-.9L7 1z"/>
            </svg>
        </button>
    `;
    railRow.appendChild(headerActions);
    header.appendChild(railRow);
    app.appendChild(header);

    // Messages container (persistent, children managed by updateMessages)
    const messagesContainer = el('div', 'messages');
    messagesContainer.id = 'messages';
    const streamingContainer = el('div', 'streaming-message message-group-assistant');
    streamingContainer.id = 'streaming-message';
    messagesContainer.appendChild(streamingContainer);
    const spacer = el('div', 'messages-spacer');
    messagesContainer.appendChild(spacer);
    app.appendChild(messagesContainer);

    // Scroll-to-bottom button (static)
    const scrollWrap = el('div', 'scroll-btn-wrap');
    const scrollBtn = el('button', 'scroll-bottom-btn');
    scrollBtn.id = 'btn-scroll-bottom';
    scrollBtn.title = t('header.scrollToBottom');
    scrollBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3L8 13M8 13L3 8M8 13L13 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    scrollWrap.appendChild(scrollBtn);
    app.appendChild(scrollWrap);

    // Input container: changed-files slot + occupancy banner + compaction banner + queued section + slash menu + input-area (persistent textarea) + footer
    const inputContainer = el('div', 'input-container');
    const occupancyBanner = el('div', 'compaction-banner occupancy-banner');
    occupancyBanner.id = 'occupancy-banner';
    occupancyBanner.style.display = 'none';
    inputContainer.appendChild(occupancyBanner);
    const editBanner = el('div', 'edit-banner');
    editBanner.id = 'edit-banner';
    editBanner.style.display = 'none';
    inputContainer.appendChild(editBanner);
    const compactionBanner = el('div', 'compaction-banner');
    compactionBanner.id = 'compaction-banner';
    compactionBanner.style.display = 'none';
    inputContainer.appendChild(compactionBanner);
    const queuedSection = document.createElement('details');
    queuedSection.className = 'queued-section';
    queuedSection.id = 'queued-section';
    queuedSection.style.display = 'none';
    inputContainer.appendChild(queuedSection);
    const slashMenu = el('div', 'slash-menu');
    slashMenu.id = 'slash-menu';
    slashMenu.style.display = 'none';
    inputContainer.appendChild(slashMenu);
    const mentionMenu = el('div', 'mention-menu');
    mentionMenu.id = 'mention-menu';
    mentionMenu.style.display = 'none';
    inputContainer.appendChild(mentionMenu);
    const selectionChip = el('div', 'selection-chip');
    selectionChip.id = 'selection-chip';
    selectionChip.style.display = 'none';
    inputContainer.appendChild(selectionChip);
    const imageChips = el('div', 'image-chips');
    imageChips.id = 'image-chips';
    imageChips.style.display = 'none';
    inputContainer.appendChild(imageChips);
    const attachChips = el('div', 'attach-chips');
    attachChips.id = 'attach-chips';
    attachChips.style.display = 'none';
    inputContainer.appendChild(attachChips);
    const imageFileInput = document.createElement('input');
    imageFileInput.type = 'file';
    imageFileInput.id = 'image-file-input';
    // Any file type: images ride the image pipeline, text files are inlined.
    imageFileInput.multiple = true;
    imageFileInput.style.display = 'none';
    inputContainer.appendChild(imageFileInput);
    const area = el('div', 'input-area');
    area.innerHTML = `<textarea id="input" placeholder="${escHtml(t('input.ask'))}" rows="1"></textarea>`;
    inputContainer.appendChild(area);
    const footer = el('div', 'input-footer cstrip');
    inputContainer.appendChild(footer);
    app.appendChild(inputContainer);

    // Bind stable event listeners (these elements persist for the lifetime of the skeleton)
    bindStableEvents();
    bindScrollListener();
    updateEditBanner();
    scrollBtn.addEventListener('click', () => {
        userHasScrolled = false;
        scrollToBottom(true);
        updateScrollButton();
    });

    skeletonBuilt = true;

    // Populate all dynamic sections
    updateTabs();
    updateStatusChip();
    updateMessages();
    updateInputArea();
    updateChangedFiles();
    updateCompactionBanner();
    updateSelectionChip();
    updateImageChips();
    updateOccupancyBanner();
    scrollToBottom();
}

async function updateMessages(): Promise<void> {
    // First call loads the markdown chunk; later calls resolve immediately.
    // A frame that cannot load the engine falls back to plain-escaped message
    // rendering rather than stalling the whole conversation view.
    try {
        await prepareMarkdown();
    } catch (err) {
        console.error('[pi-vscode] markdown engine failed to load:', err);
    }

    // Re-query after the await: a concurrent render() may have replaced the
    // tree while we waited, so pre-await references can be stale.
    const container = document.getElementById('messages');
    if (!container) return;

    const streamingEl = document.getElementById('streaming-message');
    const spacerEl = container.querySelector('.messages-spacer');

    // Remove all children before #streaming-message (the message nodes)
    while (container.firstChild && container.firstChild !== streamingEl) {
        container.removeChild(container.firstChild);
    }

    resetCodeBlockIds();

    const nodes = buildMessageTree({
        messages: state.messages,
        isStreaming: state.isStreaming,
        fileChanges: state.fileChanges,
        imageCache: state.imageCache,
        rollbackPoint: state.rollbackPoint,
        approvalTraces: state.approvalTraces,
    });
    for (const node of nodes) {
        container.insertBefore(node, streamingEl!);
    }

    bindCopyButtons();
    bindCodeBlockActions();
    bindCheckpointButtons();
    bindMessageActionButtons();
    bindWelcomeSuggestions();
    bindRedoButtons();
    bindDiffButtons();
    bindToolClickable();

    // The first content render happens asynchronously (after the markdown
    // chunk resolves), so the caller's own scrollToBottom may have run against
    // an empty container. Take the scroll here when the user hasn't claimed it.
    if (!userHasScrolled) {
        scrollToBottom();
        updateScrollButton();
    }
}

function updateTabs(): void {
    const tabStrip = document.querySelector('.tab-strip');
    if (!tabStrip) return;
    tabStrip.innerHTML = '';

    for (const tab of state.tabs) {
        const tabEl = el('div', `tab${tab.isActive ? ' tab-active' : ''}${tab.isStreaming ? ' tab-streaming' : ''}`);
        tabEl.dataset.tabId = tab.id;

        const icon = el('span', 'tab-icon');
        if (tab.isStreaming) {
            icon.innerHTML = '<span class="tab-spinner"></span>';
        } else if (tab.hasNotification) {
            icon.innerHTML = `<svg class="tab-icon-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 5.5a4 4 0 0 1 8 0c0 2.5 1 4 2 5H2c1-1 2-2.5 2-5zM6.5 13a1.5 1.5 0 0 0 3 0"/></svg>`;
        } else {
            icon.innerHTML = `<svg class="tab-icon-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 3h12v8H4l-2 2V3z"/></svg>`;
        }

        const name = el('span', 'tab-name');
        const displayName = tab.name.length > 20
            ? tab.name.substring(0, 18) + '...'
            : tab.name;
        name.textContent = displayName;
        name.title = tab.name;

        tabEl.appendChild(icon);
        tabEl.appendChild(name);

        if (state.tabs.length > 1) {
            const closeBtn = el('button', 'tab-close');
            closeBtn.innerHTML = '&times;';
            closeBtn.title = t('header.closeTab');
            closeBtn.dataset.tabId = tab.id;
            tabEl.appendChild(closeBtn);
        }

        tabStrip.appendChild(tabEl);
    }

    bindTabEvents();
}

function updateStatusChip(): void {
    const chip = document.getElementById('status-chip');
    if (!chip) return;
    const cfg = state.config;
    const ok = cfg?.status === 'ok';
    chip.classList.toggle('status-ok', ok);
    const label = chip.querySelector('.status-label');
    if (!label) return;
    if (!cfg) {
        label.textContent = '';
        chip.title = t('config.discovering');
        return;
    }
    const statusText =
        cfg.status === 'ok' ? t('header.ready') :
        cfg.status === 'not-found' ? t('config.notFoundShort') :
        t('config.partialShort');
    label.textContent = statusText;
    chip.title = t('header.readyTitle', { providers: cfg.providers.length, models: cfg.models.length });
}

function updateInputArea(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (input) {
        const readOnly = isSessionReadOnly();
        const inputHint = readOnly
            ? t('occupancy.readOnlyBlocked')
            : state.isStreaming ? t('input.queue') : t('input.ask');
        input.placeholder = inputHint;
        input.title = inputHint;
        input.setAttribute('aria-label', inputHint);
        input.disabled = readOnly;
    }

    const footer = document.querySelector('.input-footer');
    if (!footer) return;
    footer.classList.toggle('input-footer-streaming', state.isStreaming);

    const modelName = state.model?.name ?? state.model?.id ?? '';

    // The composer becomes a status-bar-style strip: left = model + context
    // meter (the "instrument"), right = transport controls (abort/steer/attach/send).
    const meterHtml = (() => {
        if (!state.contextUsage) return '';
        const cu = state.contextUsage;
        const tokensK = cu.tokens != null ? formatTokenCount(cu.tokens) : null;
        const windowK = formatTokenCount(cu.contextWindow);
        const pct = cu.percent != null ? Math.round(cu.percent) : null;
        if (tokensK !== null && pct !== null) {
            return `<span class="meter" title="${escAttr(t('input.contextTooltip', { tokens: tokensK, window: windowK, percent: pct }))}">
                <span class="meter-track"><span class="meter-fill" style="width:${pct}%"></span></span>
                <span class="meter-label">${escHtml(tokensK)} / ${escHtml(windowK)} &middot; ${pct}%</span>
            </span>`;
        }
        return `<span class="footer-context" title="${escAttr(t('input.contextWindowTooltip', { window: windowK }))}">${escHtml(windowK)}</span>`;
    })();

    const steerBtnHtml = state.isStreaming
        ? `<button id="btn-steer" class="steer-btn" title="${escHtml(t('input.steer'))}"><svg class="steer-icon-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6l4-4 4 4M4 10l4 4 4-4"/></svg></button>`
        : '';

    // Always visible (like the paperclip in Copilot/Claude Code): attaching on a
    // non-vision model surfaces image.unsupported instead of hiding the affordance.
    const attachBtnHtml = !state.isStreaming
        ? `<button id="btn-attach" class="attach-btn" title="${escHtml(t('image.attach'))}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 7.2l-5.3 5.3a3.4 3.4 0 0 1-4.8-4.8l5.4-5.4a2.3 2.3 0 0 1 3.2 3.2L6.6 10.9a1.15 1.15 0 0 1-1.6-1.6l4.9-4.9"/></svg></button>`
        : '';

    footer.innerHTML = `
        <div class="cstrip-left">
            <span class="footer-model" title="${escHtml(t('models.selectPlaceholder'))}">${escHtml(modelName)}</span>
            ${meterHtml}
        </div>
        <div class="cstrip-right">
        ${state.isStreaming ? `<button id="btn-abort" class="abort-btn" title="${escHtml(t('input.stop'))}">&#9632; ${escHtml(t('input.stop'))}</button>` : ''}
        ${steerBtnHtml}
        ${attachBtnHtml}
        <button id="btn-send" class="send-btn" title="${escHtml(state.isStreaming ? t('input.queueSend') : t('input.send'))}"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3L8 13M8 3L3 8M8 3L13 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
    `;

    // Rebind the dynamic footer elements
    const sendBtn = document.getElementById('btn-send');
    sendBtn?.addEventListener('click', () => {
        if (state.isStreaming) {
            const text = input?.value.trim();
            if (text) {
                vscode.postMessage({ type: 'queueMessage', text });
                if (input) { input.value = ''; input.style.height = 'auto'; }
            } else {
                vscode.postMessage({ type: 'abort' });
            }
        } else {
            sendMessage();
        }
    });

    const steerBtn = document.getElementById('btn-steer');
    steerBtn?.addEventListener('click', () => {
        const text = input?.value.trim();
        if (text) {
            vscode.postMessage({ type: 'steer', text });
            if (input) { input.value = ''; input.style.height = 'auto'; }
            showSteerToast(text);
        }
    });

    const abortBtn = document.getElementById('btn-abort');
    abortBtn?.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));

    const attachBtn = document.getElementById('btn-attach');
    attachBtn?.addEventListener('click', () => {
        const fileInput = document.getElementById('image-file-input') as HTMLInputElement | null;
        fileInput?.click();
    });

    document.querySelector('.footer-model')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleModelPicker();
    });

    updateQueuedMessageBanner();
}

let queuedEditingIndex = -1;

function updateQueuedMessageBanner(): void {
    const section = document.getElementById('queued-section') as HTMLDetailsElement | null;
    if (!section) return;

    if (state.queuedMessages.length === 0) {
        section.style.display = 'none';
        section.innerHTML = '';
        queuedEditingIndex = -1;
        return;
    }

    section.style.display = '';
    section.open = true;

    const count = state.queuedMessages.length;
    section.innerHTML = `
        <summary class="queued-summary">
            <span class="queued-chevron">&#9656;</span>
            <span class="queued-count">${escHtml(t('queue.count', { n: count }))}</span>
        </summary>
        <div class="queued-list">
            ${state.queuedMessages.map((msg, i) => {
                if (i === queuedEditingIndex) {
                    return `<div class="queued-item queued-item-editing" data-index="${i}">
                        <span class="queued-item-icon">&#9675;</span>
                        <input class="queued-edit-input" data-index="${i}" type="text" value="${escAttr(msg)}">
                        <button class="queued-edit-save" data-index="${i}" title="${escHtml(t('queue.save'))}">&#10003;</button>
                        <button class="queued-edit-cancel" data-index="${i}" title="${escHtml(t('queue.cancel'))}">&#10005;</button>
                    </div>`;
                }
                return `<div class="queued-item" data-index="${i}">
                    <span class="queued-item-icon">&#9675;</span>
                    <span class="queued-item-text">${escHtml(msg)}</span>
                    <span class="queued-item-actions">
                        <button class="queued-item-btn queued-item-edit" data-index="${i}" title="${escHtml(t('queue.edit'))}"><svg class="queued-btn-svg" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg></button>
                        <button class="queued-item-btn queued-item-delete" data-index="${i}" title="${escHtml(t('queue.remove'))}"><svg class="queued-btn-svg" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4h10M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1M6 7v4M8 7v4M10 7v4M4 4l.7 9.1a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4"/></svg></button>
                    </span>
                </div>`;
            }).join('')}
        </div>
    `;

    bindQueuedItemEvents(section);
}

function updateCompactionBanner(): void {
    const banner = document.getElementById('compaction-banner');
    if (!banner) return;
    if (state.compactionPrompt == null) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }
    banner.style.display = '';
    if (state.compactionBusy) {
        banner.innerHTML = `
            <span class="compaction-banner-title">${escHtml(t('compact.compacting'))}</span>
            <span class="compaction-banner-actions">
                <button class="compaction-btn compaction-dismiss" id="compaction-dismiss">${escHtml(t('compact.dismiss'))}</button>
            </span>
        `;
        document.getElementById('compaction-dismiss')?.addEventListener('click', () => {
            state.compactionPrompt = null;
            state.compactionBusy = false;
            updateCompactionBanner();
            vscode.postMessage({ type: 'compactionDismiss' });
        });
        return;
    }
    banner.innerHTML = `
        <span class="compaction-banner-title">${escHtml(t('compact.bannerTitle', { n: Math.round(state.compactionPrompt) }))}</span>
        <span class="compaction-banner-hint">${escHtml(t('compact.bannerHint'))}</span>
        <span class="compaction-banner-actions">
            <button class="compaction-btn compaction-accept" id="compaction-accept">${escHtml(t('compact.accept'))}</button>
            <button class="compaction-btn compaction-dismiss" id="compaction-dismiss">${escHtml(t('compact.dismiss'))}</button>
        </span>
    `;
    document.getElementById('compaction-accept')?.addEventListener('click', () => {
        state.compactionBusy = true;
        updateCompactionBanner();
        vscode.postMessage({ type: 'compactionAccept' });
    });
    document.getElementById('compaction-dismiss')?.addEventListener('click', () => {
        state.compactionPrompt = null;
        updateCompactionBanner();
        vscode.postMessage({ type: 'compactionDismiss' });
    });
}

// ── Single-writer occupancy banner (PRD 9.8) ──

function isSessionReadOnly(): boolean {
    return state.occupancy === 'occupiedByOther'
        || state.occupancy === 'releasedByOther'
        || state.occupancy === 'lostLock';
}

function updateOccupancyBanner(): void {
    updateInputArea();

    const banner = document.getElementById('occupancy-banner');
    if (!banner) { return; }
    if (!state.occupancy || state.occupancy === 'none') {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }
    banner.style.display = '';
    banner.innerHTML = buildOccupancyBannerHtml(state.occupancy);
    document.getElementById('occupancy-takeover')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'sessionTakeover' });
    });
}

function bindQueuedItemEvents(section: HTMLElement): void {
    section.querySelectorAll('.queued-item-delete').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                if (queuedEditingIndex === idx) queuedEditingIndex = -1;
                else if (queuedEditingIndex > idx) queuedEditingIndex--;
                vscode.postMessage({ type: 'removeQueuedMessage', index: idx });
            }
        });
    });

    section.querySelectorAll('.queued-item-edit').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                queuedEditingIndex = idx;
                updateQueuedMessageBanner();
                const input = section.querySelector(`.queued-edit-input[data-index="${idx}"]`) as HTMLInputElement | null;
                if (input) {
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            }
        });
    });

    section.querySelectorAll('.queued-edit-save').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            const input = section.querySelector(`.queued-edit-input[data-index="${idx}"]`) as HTMLInputElement | null;
            if (idx >= 0 && input && input.value.trim()) {
                queuedEditingIndex = -1;
                vscode.postMessage({ type: 'editQueuedMessage', index: idx, text: input.value.trim() });
            }
        });
    });

    section.querySelectorAll('.queued-edit-cancel').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            queuedEditingIndex = -1;
            updateQueuedMessageBanner();
        });
    });

    section.querySelectorAll('.queued-edit-input').forEach((input) => {
        input.addEventListener('keydown', (e) => {
            const ke = e as KeyboardEvent;
            const idx = parseInt((input as HTMLElement).dataset.index ?? '-1', 10);
            if (ke.key === 'Enter') {
                ke.preventDefault();
                const val = (input as HTMLInputElement).value.trim();
                if (idx >= 0 && val) {
                    queuedEditingIndex = -1;
                    vscode.postMessage({ type: 'editQueuedMessage', index: idx, text: val });
                }
            }
            if (ke.key === 'Escape') {
                ke.preventDefault();
                queuedEditingIndex = -1;
                updateQueuedMessageBanner();
            }
        });
    });
}
function showSteerToast(text: string): void {
    const existing = document.getElementById('steer-toast');
    if (existing) existing.remove();

    const container = document.querySelector('.input-container');
    if (!container) return;

    const toast = el('div', 'steer-toast');
    toast.id = 'steer-toast';
    toast.innerHTML = `
        <span class="steer-toast-indicator"></span>
        <span class="steer-toast-label">${escHtml(t('stream.steering'))}</span>
        <span class="steer-toast-text">${escHtml(truncate(text, 80))}</span>
    `;

    const inputArea = container.querySelector('.input-area');
    if (inputArea) {
        container.insertBefore(toast, inputArea);
    } else {
        container.appendChild(toast);
    }
}

function clearStreamingState(): void {
    state.streamingText = '';
    state.streamingThinking = '';
    state.isThinking = false;
}

function dismissSteerToast(): void {
    const toast = document.getElementById('steer-toast');
    if (!toast) return;
    toast.classList.add('steer-toast-fade');
    setTimeout(() => toast.remove(), 300);
}

// ── Changed Files section ──

function updateChangedFiles(): void {
    const container = document.querySelector('.input-container');
    if (!container) return;

    const existing = document.getElementById('changed-files-bar') as HTMLDetailsElement | null;
    const wasOpen = existing?.open ?? false;

    if (state.fileChanges.length === 0) {
        existing?.remove();
        return;
    }

    const newSection = buildChangedFilesSection(state.fileChanges, state.rollbackPoint);
    if (wasOpen) {
        (newSection as HTMLDetailsElement).open = true;
    }

    if (existing) {
        existing.replaceWith(newSection);
    } else {
        container.insertBefore(newSection, container.firstChild);
    }

    bindChangedFileItems();

    const undoBtn = document.getElementById('btn-undo');
    undoBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        let lastUserTurn = 0;
        for (const msg of state.messages) {
            if ((msg.role ?? 'unknown') === 'user') lastUserTurn++;
        }
        if (lastUserTurn < 1) return;
        vscode.postMessage({
            type: 'confirmAction',
            action: 'restoreCheckpoint',
            message: t('files.undoConfirm'),
            payload: { messageIndex: lastUserTurn - 1 },
        });
    });

    const redoBtn = document.getElementById('btn-redo');
    redoBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        vscode.postMessage({
            type: 'confirmAction',
            action: 'redoCheckpoint',
            message: t('files.redoConfirm'),
        });
    });

    const reviewBtn = document.getElementById('btn-review-all');
    reviewBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const seen = new Set<string>();
        for (const change of state.fileChanges) {
            if (!seen.has(change.filePath)) {
                seen.add(change.filePath);
                vscode.postMessage({ type: 'openDiff', filePath: change.filePath, toolCallId: change.toolCallId });
            }
        }
    });
}

function renderChangedFilesBar(): void {
    const existing = document.getElementById('changed-files-bar');
    if (existing) {
        const fileMap = new Map<string, FileChangeInfo>();
        for (const c of state.fileChanges) {
            fileMap.set(c.filePath, c);
        }
        const count = fileMap.size;
        const countEl = existing.querySelector('.changed-files-count');
        if (countEl) {
            countEl.textContent = t(count === 1 ? 'files.countOne' : 'files.countMany', { n: count });
        }
    }
}

function renderInlineFileChange(change: FileChangeInfo): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    const existing = document.getElementById(`diff-${change.toolCallId}`);
    if (existing) return;

    const card = buildDiffCard(change);

    const loadingCard = document.getElementById(`tool-${change.toolCallId}`);
    if (loadingCard) {
        loadingCard.replaceWith(card);
    } else {
        container.appendChild(card);
    }

    bindDiffButtons();
    scrollToBottom();
}

// ── Inline diff card ──

// ── Message rendering ──

function removePreparingPlaceholder(): void {
    document.getElementById('preparing-placeholder')?.remove();
}

function showPreparingPlaceholder(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    if (document.getElementById('preparing-placeholder')) return;
    const ph = el('div', 'preparing-placeholder');
    ph.id = 'preparing-placeholder';
    ph.textContent = t('stream.preparing');
    container.appendChild(ph);
    scrollToBottom();
}

function ensurePreparingPlaceholder(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    const hasRunningTool = container.querySelector('.tool-status.running');
    if (!hasRunningTool) {
        showPreparingPlaceholder();
    }
}

function showRetryPlaceholder(attempt: number, maxAttempts: number, delayMs: number, errorMessage: string): void {
    removePreparingPlaceholder();
    removeRetryPlaceholder();
    const container = document.getElementById('streaming-message');
    if (!container) return;
    const ph = el('div', 'preparing-placeholder retry-placeholder');
    ph.id = 'retry-placeholder';
    ph.textContent = t('stream.retrying', { attempt, max: maxAttempts, error: truncate(errorMessage, 80) });
    container.appendChild(ph);
    scrollToBottom();
}

function removeRetryPlaceholder(): void {
    document.getElementById('retry-placeholder')?.remove();
}

// The streaming region reconciles against streaming state: frames and deltas
// hit the same seam, so a frame can never wipe the block-diff cache or blank a
// live assistant message. `clearStreamingRegion` remains only for the honest
// turn boundaries (start/end/settle) where the region must be emptied.
function renderStreamingContent(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    if (!state.isStreaming) {
        container.innerHTML = '';
        return;
    }

    const hasContent = state.streamingText !== '' || state.streamingThinking !== '';
    if (!hasContent) return; // keep transient tool/approval cards and placeholders

    removePreparingPlaceholder();

    if (!container.querySelector(':scope > .message')) {
        container.innerHTML = '';
        container.appendChild(buildStreamingSkeleton());
    }

    const thinkingEl = document.getElementById('streaming-thinking');
    updateStreamingThinking(thinkingEl, {
        thinking: state.streamingThinking,
        isThinking: state.isThinking,
        durationSec: state.streamingThinkingDuration,
    });

    const textEl = document.getElementById('streaming-text');
    if (textEl) {
        reconcileStreamingText(textEl, state.streamingText);
    }

    bindCopyButtons();
    bindCodeBlockActions();
    scrollToBottom();
}

function clearStreamingRegion(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    container.innerHTML = '';
}

// ── Tool rendering ──

function renderToolStart(event: any): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    if ((event.toolName === 'edit' || event.toolName === 'write') && event.args?.path) {
        const card = el('div', 'diff-card loading');
        card.id = `tool-${event.toolCallId}`;
        const fileName = (event.args.path as string).split('/').pop() ?? event.args.path;
        card.innerHTML = `
            <div class="diff-file-header">
                <span class="diff-file-icon">&#9998;</span>
                <span class="diff-file-name">${escHtml(fileName)}</span>
                <span class="tool-status running">${escHtml(t('tool.running'))}</span>
            </div>
        `;
        container.appendChild(card);
        applyMemoryBadge(card, event.toolCallId, state.approvalTraces);
        scrollToBottom();
        return;
    }

    const parsedArgs = typeof event.args === 'string' ? tryParseJSON(event.args) : event.args;
    const nameLower = (event.toolName ?? '').toLowerCase();
    const isRead = nameLower === 'read';
    const filePath = parsedArgs?.path ?? parsedArgs?.file_path ?? '';

    const card = el('div', `tool-card${isRead ? ' tool-clickable' : ''}`);
    card.id = `tool-${event.toolCallId}`;
    card.dataset.toolName = event.toolName;
    if (isRead && filePath) card.dataset.filepath = filePath;

    card.appendChild(buildToolCardHeader(
        event.toolName,
        getToolLabel(event.toolName, parsedArgs),
        `<span class="tool-status running">${escHtml(t('tool.running'))}</span>`,
    ));

    container.appendChild(card);
    applyMemoryBadge(card, event.toolCallId, state.approvalTraces);
    bindToolClickable();
    scrollToBottom();
}

function renderToolUpdate(event: any): void {
    const card = document.getElementById(`tool-${event.toolCallId}`);
    if (!card) return;
    if (card.classList.contains('diff-card')) return;
    const text = extractToolResultText(event.partialResult);
    if (!text) return;
    let resultEl = card.querySelector('.tool-result') as HTMLElement | null;
    if (!resultEl) {
        resultEl = el('pre', 'tool-result');
        card.appendChild(resultEl);
    }
    resultEl.textContent = text;
    scrollToBottom();
}

function renderToolEnd(event: any): void {
    const card = document.getElementById(`tool-${event.toolCallId}`);
    if (!card) return;

    if (card.classList.contains('diff-card')) {
        const statusEl = card.querySelector('.tool-status');
        if (statusEl) {
            statusEl.textContent = event.isError ? t('tool.error') : t('tool.done');
            statusEl.className = `tool-status ${event.isError ? 'error' : 'done'}`;
        }
        return;
    }

    const toolName = (card as HTMLElement).dataset.toolName ?? '';
    const text = extractToolResultText(event.result);
    const isBash = toolName.toLowerCase() === 'bash';
    const hasBody = !!(text || isBash);

    if (hasBody) {
        const details = document.createElement('details');
        details.className = card.className.replace('tool-card', 'tool-card tool-expandable');
        details.id = card.id;
        details.dataset.toolName = toolName;
        if (card.dataset.filepath) details.dataset.filepath = card.dataset.filepath;

        const headerEl = card.querySelector('.tool-header');
        const nameHtml = headerEl?.innerHTML ?? '';

        details.innerHTML = `<summary class="tool-header">${nameHtml}</summary>`;

        const statusEl = details.querySelector('.tool-status');
        if (statusEl) {
            if (event.isError) {
                statusEl.textContent = t('tool.error');
                statusEl.className = 'tool-status error';
            } else {
                statusEl.remove();
            }
        }

        const arrow = el('span', 'tool-expand-arrow');
        arrow.innerHTML = '&#9656;';
        details.querySelector('summary')?.appendChild(arrow);

        const body = el('div', 'tool-body');
        const resultEl = el('pre', 'tool-result');
        resultEl.textContent = text || t('tool.noOutput');
        if (!text) resultEl.classList.add('empty');
        body.appendChild(resultEl);
        details.appendChild(body);

        card.replaceWith(details);
        applyMemoryBadge(details, event.toolCallId, state.approvalTraces);
        bindToolClickable();
    } else {
        const statusEl = card.querySelector('.tool-status');
        if (statusEl) {
            if (event.isError) {
                statusEl.textContent = t('tool.error');
                statusEl.className = 'tool-status error';
            } else {
                statusEl.remove();
            }
        }
    }
}

// ── Tool approval cards ──

function renderToolApprovalCard(pending: ToolCallPendingInfo): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    removePreparingPlaceholder();

    const existing = document.getElementById(`approval-${pending.toolCallId}`);
    if (existing) return;

    if (!state.pendingApprovals.some(p => p.toolCallId === pending.toolCallId)) {
        state.pendingApprovals.push(pending);
    }

    const card = buildToolApprovalCard(pending);

    container.appendChild(card);
    bindApprovalButtons();
    bindRememberButtons(card);
    scrollToBottom();
}

function bindRememberButtons(card: HTMLElement): void {
    const rememberBtn = card.querySelector('.approval-btn.remember');
    const menu = card.querySelector('.remember-menu') as HTMLElement | null;
    if (!rememberBtn || !menu) return;

    rememberBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
    });

    card.querySelectorAll('.remember-option').forEach((option) => {
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            const el0 = option as HTMLElement;
            const toolCallId = el0.dataset.toolcallid;
            const scope = el0.dataset.scope as ApprovalScope;
            if (!toolCallId || !scope) return;
            vscode.postMessage({ type: 'rememberToolApproval', toolCallId, scope });
            removeToolApprovalCard(toolCallId);
        });
    });
}

function removeToolApprovalCard(toolCallId: string): void {
    document.getElementById(`approval-${toolCallId}`)?.remove();
    state.pendingApprovals = state.pendingApprovals.filter(p => p.toolCallId !== toolCallId);
}

function bindApprovalButtons(): void {
    document.querySelectorAll('.approval-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const toolCallId = (btn as HTMLElement).dataset.toolcallid;
            if (!toolCallId) return;
            if (btn.classList.contains('approve')) {
                vscode.postMessage({ type: 'approveToolCall', toolCallId });
            } else {
                vscode.postMessage({ type: 'rejectToolCall', toolCallId });
            }
            removeToolApprovalCard(toolCallId);
        });
    });
}

// ── Apply preview cards (code block → file) ──

function renderApplyPreviewCard(preview: ApplyPreviewInfo): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    removePreparingPlaceholder();

    if (document.getElementById(`apply-preview-${preview.previewId}`)) return;
    if (!state.applyPreviews.some(p => p.previewId === preview.previewId)) {
        state.applyPreviews.push(preview);
    }

    const card = buildApplyPreviewCard(preview);

    container.appendChild(card);

    card.querySelector('.apply-confirm')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'applyConfirm', previewId: preview.previewId });
        removeApplyPreviewCard(preview.previewId);
    });
    card.querySelector('.apply-cancel')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'applyCancel', previewId: preview.previewId });
        removeApplyPreviewCard(preview.previewId);
    });

    scrollToBottom();
}

function removeApplyPreviewCard(previewId: string): void {
    document.getElementById(`apply-preview-${previewId}`)?.remove();
    state.applyPreviews = state.applyPreviews.filter(p => p.previewId !== previewId);
}

function showNotice(message: string): void {
    showToast({ containerId: 'messages', className: 'notice-toast', message, durationMs: 4000 });
    scrollToBottom();
}

// ── Thinking block ──

// ── Model picker popup ──

let pendingModelPicker = false;
let configRequested = false;

function toggleModelPicker(): void {
    const existing = document.getElementById('model-picker');
    if (existing) {
        existing.remove();
        pendingModelPicker = false;
        return;
    }

    // Config discovery (agent dir + models + skills scan) is deferred off the
    // panel-open path; request the snapshot the first time the picker needs it.
    if (!state.config && !configRequested) {
        configRequested = true;
        vscode.postMessage({ type: 'getConfig' });
    }

    if (state.availableModels.length === 0) {
        pendingModelPicker = true;
        vscode.postMessage({ type: 'getModels' });
        return;
    }

    showModelPicker();
}

function addToRecentModels(provider: string, id: string, name?: string): void {
    state.recentModels = state.recentModels.filter(
        m => !(m.id === id && m.provider === provider)
    );
    state.recentModels.unshift({ provider, id, name });
    if (state.recentModels.length > 5) {
        state.recentModels = state.recentModels.slice(0, 5);
    }
}

function showModelPicker(): void {
    const existing = document.getElementById('model-picker');
    if (existing) existing.remove();

    const container = document.querySelector('.input-container');
    if (!container) return;

    const picker = el('div', 'model-picker');
    picker.id = 'model-picker';

    const searchInput = document.createElement('input');
    searchInput.className = 'model-search';
    searchInput.placeholder = t('models.search');
    searchInput.type = 'text';
    picker.appendChild(searchInput);

    const configBanner = buildConfigBanner(state.config);
    if (configBanner) {
        picker.appendChild(configBanner);
        configBanner.querySelector('.config-refresh')?.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'refreshConfig' });
        });
    }

    const list = el('div', 'model-list');

    if (state.recentModels.length > 0) {
        const recentHeader = el('div', 'model-section-header');
        recentHeader.textContent = t('models.recent');
        list.appendChild(recentHeader);

        for (const r of state.recentModels) {
            const full = state.availableModels.find(
                m => m.id === r.id && m.provider === r.provider
            );
            if (full) {
                list.appendChild(buildModelItem(full, state.model));
            }
        }

        const allHeader = el('div', 'model-section-header');
        allHeader.textContent = t('models.all');
        list.appendChild(allHeader);
    }

    for (const m of state.availableModels) {
        list.appendChild(buildModelItem(m, state.model));
    }
    picker.appendChild(list);

    const thinkingRow = el('div', 'thinking-chips');
    const thinkingCaption = el('span', 'thinking-label');
    thinkingCaption.textContent = t('models.thinking');
    thinkingRow.appendChild(thinkingCaption);
    const supported = state.supportsThinking && (state.availableThinkingLevels?.length ?? 0) > 0;
    if (supported) {
        for (const level of state.availableThinkingLevels!) {
            const chip = el('button', `thinking-chip${level === state.thinkingLevel ? ' active' : ''}`);
            chip.textContent = level.charAt(0).toUpperCase() + level.slice(1);
            chip.dataset.level = level;
            thinkingRow.appendChild(chip);
        }
    } else {
        thinkingRow.style.display = 'none';
    }
    picker.appendChild(thinkingRow);

    container.appendChild(picker);

    searchInput.focus();

    searchInput.addEventListener('input', () => {
        const q = searchInput.value;
        list.querySelectorAll('.model-item').forEach((item) => {
            const name = (item as HTMLElement).dataset.name ?? '';
            (item as HTMLElement).style.display = matchesModelFilter(name, q) ? '' : 'none';
        });
        list.querySelectorAll('.model-section-header').forEach((hdr) => {
            (hdr as HTMLElement).style.display = q ? 'none' : '';
        });
    });

    list.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest('.model-item') as HTMLElement | null;
        if (!item) return;
        const provider = item.dataset.provider!;
        const modelId = item.dataset.modelId!;
        vscode.postMessage({ type: 'setModel', provider, modelId });
        const matched = state.availableModels.find(m => m.id === modelId && m.provider === provider);
        if (matched) {
            state.model = { provider, id: modelId, name: matched.name ?? modelId };
            addToRecentModels(provider, modelId, matched.name ?? modelId);
        }
        updateFooterModel();
        closeModelPicker();
    });

    thinkingRow.addEventListener('click', (e) => {
        const chip = (e.target as HTMLElement).closest('.thinking-chip') as HTMLElement | null;
        if (!chip) return;
        vscode.postMessage({ type: 'setThinkingLevel', level: chip.dataset.level! });
        thinkingRow.querySelectorAll('.thinking-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.thinkingLevel = chip.dataset.level;
    });

    setTimeout(() => {
        document.addEventListener('click', onClickOutsidePicker);
    }, 0);
}

function onClickOutsidePicker(e: MouseEvent): void {
    const picker = document.getElementById('model-picker');
    if (picker && !picker.contains(e.target as Node)) {
        closeModelPicker();
    }
}

function closeModelPicker(): void {
    document.getElementById('model-picker')?.remove();
    document.removeEventListener('click', onClickOutsidePicker);
}

function updateFooterModel(): void {
    const el = document.querySelector('.footer-model');
    if (el) {
        el.textContent = state.model?.name ?? state.model?.id ?? '';
    }
}

// ── Session list ──

function renderSessionList(sessions: any[], currentId?: string): void {
    let panel = document.getElementById('session-panel');
    if (!panel) {
        panel = el('div', 'session-panel');
        panel.id = 'session-panel';
        const app = document.getElementById('app');
        const modelBar = document.getElementById('model-bar');
        if (app && modelBar?.nextSibling) {
            app.insertBefore(panel, modelBar.nextSibling);
        } else {
            app?.appendChild(panel);
        }
    }

    if (sessions.length === 0) {
        panel.innerHTML = `
            <div class="session-header">
                <span>${escHtml(t('sessions.title'))}</span>
                <button class="icon-btn" id="btn-close-sessions" title="${escHtml(t('sessions.close'))}">&times;</button>
            </div>
            <div class="session-empty">${escHtml(t('sessions.empty'))}</div>
        `;
        document.getElementById('btn-close-sessions')?.addEventListener('click', () => panel?.remove());
        return;
    }

    const query = (sessionSearchQuery ?? '').toLowerCase();
    const filtered = query
        ? sessions.filter((s) => (s.name ?? s.id ?? '').toLowerCase().includes(query))
        : sessions;

    panel.innerHTML = `
        <div class="session-header">
            <span>${escHtml(t('sessions.title'))}</span>
            <button class="icon-btn" id="btn-close-sessions" title="${escHtml(t('sessions.close'))}">&times;</button>
        </div>
        <div class="session-search">
            <svg class="session-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg>
            <input type="text" id="session-search-input" placeholder="${escHtml(t('sessions.search'))}" value="${escAttr(sessionSearchQuery ?? '')}" aria-label="${escHtml(t('sessions.search'))}">
        </div>
        <div class="session-list">
            ${filtered.length === 0
                ? `<div class="session-empty">${escHtml(t('sessions.noMatch'))}</div>`
                : filtered.map(s => {
                    const name = s.name ?? s.id ?? '';
                    return `
                        <div class="session-item ${s.id === currentId ? 'active' : ''}" data-path="${escAttr(s.path)}">
                            <span class="session-item-name" title="${escAttr(name)}">${escHtml(name)}</span>
                            <button class="session-item-rename" title="${escHtml(t('header.renameSession'))}">✎</button>
                        </div>
                    `;
                }).join('')}
        </div>
    `;

    document.getElementById('btn-close-sessions')?.addEventListener('click', () => panel?.remove());
    const searchInput = document.getElementById('session-search-input') as HTMLInputElement | null;
    searchInput?.addEventListener('input', () => {
        sessionSearchQuery = searchInput.value;
        renderSessionList(sessions, currentId);
        const input = document.getElementById('session-search-input') as HTMLInputElement | null;
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });

    panel.querySelectorAll('.session-item').forEach((item) => {
        const renameBtn = item.querySelector('.session-item-rename') as HTMLElement | null;
        item.addEventListener('click', (ev) => {
            if (renameBtn && (renameBtn.contains(ev.target as Node) || ev.target === renameBtn)) return;
            const sessionPath = (item as HTMLElement).dataset.path;
            if (sessionPath) {
                historyReplacePending = { from: state.sessionId, rewrite: false };
                vscode.postMessage({ type: 'loadSession', sessionPath });
            }
        });
        renameBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            const sessionPath = (item as HTMLElement).dataset.path;
            const isCurrent = item.classList.contains('active');
            const nameSpan = item.querySelector('.session-item-name') as HTMLElement | null;
            const originalName = nameSpan?.textContent ?? '';
            const key = isCurrent ? '' : sessionPath ?? '';
            if (!sessionPath || item.querySelector('.session-item-rename-input')) return;
            if (nameSpan) { nameSpan.style.display = 'none'; }
            renameBtn.style.display = 'none';
            const input = document.createElement('input');
            input.className = 'session-item-rename-input';
            input.type = 'text';
            input.maxLength = 100;
            input.value = originalName;
            input.setAttribute('aria-label', t('header.renameSession'));
            item.appendChild(input);
            input.focus();
            input.select();

            const commit = (): void => {
                const value = input.value.trim();
                if (value && value !== originalName) {
                    const payload: { type: 'renameSession'; name: string; sessionPath?: string } = { type: 'renameSession', name: value };
                    if (key) { payload.sessionPath = key; }
                    vscode.postMessage(payload);
                }
                input.remove();
                if (nameSpan) { nameSpan.style.display = ''; }
                renameBtn.style.display = '';
            };
            const cancel = (): void => {
                input.remove();
                if (nameSpan) { nameSpan.style.display = ''; }
                renameBtn.style.display = '';
            };
            input.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') { commit(); }
                else if (e.key === 'Escape') { cancel(); }
            });
            input.addEventListener('blur', () => { commit(); });
        });
    });
}

/** Input-validation hints dismiss themselves; agent errors stay until the next turn. */
const ERROR_HINT_MS = 5000;

function showError(message: string, durationMs?: number): void {
    const container = document.getElementById('messages');
    if (!container) return;
    if (durationMs != null) {
        showToast({ containerId: 'messages', className: 'error-message', message, durationMs });
        scrollToBottom();
        return;
    }
    const errEl = el('div', 'error-message');
    errEl.textContent = message;
    container.appendChild(errEl);
    scrollToBottom();
}

// ── Events ──

function bindStableEvents(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const newTabBtn = document.getElementById('btn-new-tab');
    const sessionsBtn = document.getElementById('btn-sessions');
    const settingsBtn = document.getElementById('btn-settings');

    input?.addEventListener('keydown', (e) => {
        if (isMentionMenuVisible()) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const items = buildMentionMenuItems();
                mentionMenuIndex = Math.min(mentionMenuIndex + 1, items.length - 1);
                renderMentionMenu();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                mentionMenuIndex = Math.max(mentionMenuIndex - 1, 0);
                renderMentionMenu();
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                selectMentionItem(mentionMenuIndex);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                hideMentionMenu();
                return;
            }
        }
        if (isSlashMenuVisible()) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                slashMenuIndex = Math.min(slashMenuIndex + 1, slashMenuItems.length - 1);
                const menu = document.getElementById('slash-menu');
                if (menu) renderSlashMenu(menu);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                slashMenuIndex = Math.max(slashMenuIndex - 1, 0);
                const menu = document.getElementById('slash-menu');
                if (menu) renderSlashMenu(menu);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                selectSlashItem(slashMenuIndex);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                hideSlashMenu();
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (state.isStreaming) {
                if (editingTurn !== null) {
                    showError(t('edit.blockedStreaming'), ERROR_HINT_MS);
                    return;
                }
                const text = input.value.trim();
                if (text) {
                    if (e.ctrlKey || e.metaKey) {
                        vscode.postMessage({ type: 'steer', text });
                        showSteerToast(text);
                    } else {
                        vscode.postMessage({ type: 'queueMessage', text });
                    }
                    input.value = '';
                    input.style.height = 'auto';
                }
            } else {
                sendMessage();
            }
        }
        if (e.key === 'Escape' && editingTurn !== null && !state.isStreaming) {
            e.preventDefault();
            cancelEditMode();
            return;
        }
        if (e.key === 'Escape' && state.isStreaming) {
            e.preventDefault();
            vscode.postMessage({ type: 'abort' });
        }
    });

    input?.addEventListener('input', () => {
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        updateSlashMenu(input);
        updateMentionMenu(input);
    });

    newTabBtn?.addEventListener('click', () => vscode.postMessage({ type: 'createTab' }));
    sessionsBtn?.addEventListener('click', () => vscode.postMessage({ type: 'getSessions' }));
    settingsBtn?.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

    const fileInput = document.getElementById('image-file-input') as HTMLInputElement | null;
    fileInput?.addEventListener('change', () => {
        if (fileInput.files && fileInput.files.length > 0) {
            addAttachments(Array.from(fileInput.files));
        }
        fileInput.value = '';
    });

    input?.addEventListener('paste', (e) => {
        const files: File[] = [];
        for (const item of Array.from(e.clipboardData?.items ?? [])) {
            if (item.kind === 'file') {
                const f = item.getAsFile();
                if (f) files.push(f);
            }
        }
        if (files.length > 0) {
            e.preventDefault();
            addAttachments(files);
        }
    });

    const inputContainer = document.querySelector('.input-container');
    let dragDepth = 0;
    inputContainer?.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragDepth++;
        inputContainer.classList.add('drag-over');
    });
    inputContainer?.addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    inputContainer?.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) inputContainer.classList.remove('drag-over');
    });
    inputContainer?.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        inputContainer.classList.remove('drag-over');
        const dt = (e as DragEvent).dataTransfer;
        const files = Array.from(dt?.files ?? []);
        if (files.length > 0) {
            addAttachments(files);
        }
        // VS Code explorer drags carry paths in text/uri-list (no File
        // objects); they ride the same injection path as @-mention.
        const uris = parseUriList(dt?.getData('text/uri-list') ?? '');
        if (uris.length > 0) {
            dropPendingRequestId = ++mentionQuerySeq;
            vscode.postMessage({ type: 'dropFiles', uris, requestId: dropPendingRequestId });
        }
    });
}

function bindTabEvents(): void {
    document.querySelectorAll<HTMLDivElement>('.tab').forEach((tabEl) => {
        tabEl.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.tab-close')) return;
            const tabId = tabEl.dataset.tabId;
            if (tabId && tabId !== state.activeTabId) {
                vscode.postMessage({ type: 'switchTab', tabId });
            }
        });
        tabEl.addEventListener('dblclick', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.tab-close')) return;
            const tabId = tabEl.dataset.tabId;
            if (!tabId) return;
            const tab = state.tabs.find((t) => t.id === tabId);
            if (!tab) return;
            startTabRename(tabEl, tab);
        });
    });

    document.querySelectorAll('.tab-close').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabId = (btn as HTMLElement).dataset.tabId;
            if (tabId) {
                vscode.postMessage({ type: 'closeTab', tabId });
            }
        });
    });
}

function startTabRename(tabEl: HTMLElement, tab: any): void {
    if (tabEl.querySelector('.tab-rename-input')) return;
    stopClickPropagation(tabEl);
    const nameSpan = tabEl.querySelector('.tab-name') as HTMLElement | null;
    const input = document.createElement('input');
    input.className = 'tab-rename-input';
    input.type = 'text';
    input.maxLength = 100;
    input.value = tab.name;
    input.setAttribute('aria-label', t('header.renameSession'));
    stopClickPropagation(input);
    const original = tab.name;

    const commit = (): void => {
        const value = input.value.trim();
        if (value && value !== original) {
            vscode.postMessage({ type: 'renameSession', name: value });
        } else {
            input.remove();
            if (nameSpan) { nameSpan.style.display = ''; }
        }
    };
    const cancel = (): void => {
        input.remove();
        if (nameSpan) { nameSpan.style.display = ''; }
    };

    if (nameSpan) { nameSpan.style.display = 'none'; }
    tabEl.appendChild(input);
    input.focus();
    input.select();

    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { commit(); }
        else if (e.key === 'Escape') { cancel(); }
    });
    input.addEventListener('blur', () => { commit(); });
}

function stopClickPropagation(el: HTMLElement): void {
    el.addEventListener('click', (e) => e.stopPropagation());
}

function bindCheckpointButtons(): void {
    document.querySelectorAll('.checkpoint-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const turn = parseInt((btn as HTMLElement).dataset.turn ?? '-1', 10);
            if (turn < 1) return;
            vscode.postMessage({
                type: 'confirmAction',
                action: 'restoreCheckpoint',
                message: t('checkpoint.discardConfirm'),
                payload: { messageIndex: turn - 1 },
            });
        });
    });
}

function bindRedoButtons(): void {
    document.querySelectorAll('.redo-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({
                type: 'confirmAction',
                action: 'redoCheckpoint',
                message: t('files.redoConfirm'),
            });
        });
    });
}

// ── Edit / regenerate (replayTurn) ──

function findUserMessageByTurn(turn: number): any | null {
    let count = 0;
    for (const msg of state.messages) {
        if ((msg.role ?? '') === 'user') {
            count++;
            if (count === turn) return msg;
        }
    }
    return null;
}

/** dataUrls of a persisted user message's images, recovered via assetId. */
function extractUserMessageImages(msg: any): string[] {
    if (!Array.isArray(msg.content)) return [];
    const sources: string[] = [];
    for (const c of msg.content) {
        if ((c.type !== 'image' && c.type !== 'image_url') || c.assetId == null) continue;
        const dataUrl = state.imageCache[c.assetId];
        if (dataUrl) sources.push(dataUrl);
    }
    return sources;
}

function bindMessageActionButtons(): void {
    document.querySelectorAll('.regen-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const turn = parseInt((btn as HTMLElement).dataset.turn ?? '-1', 10);
            const msg = turn >= 1 ? findUserMessageByTurn(turn) : null;
            if (!msg) return;
            if (state.isStreaming) {
                showError(t('edit.blockedStreaming'), ERROR_HINT_MS);
                return;
            }
            cancelEditMode();
            historyReplacePending = { from: state.sessionId, rewrite: true };
            vscode.postMessage({
                type: 'replayTurn',
                turn,
                text: extractText(msg),
                images: extractUserMessageImages(msg),
            });
        });
    });
    document.querySelectorAll('.edit-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const turn = parseInt((btn as HTMLElement).dataset.turn ?? '-1', 10);
            const msg = turn >= 1 ? findUserMessageByTurn(turn) : null;
            if (!msg) return;
            enterEditMode(turn, extractText(msg), extractUserMessageImages(msg));
        });
    });
}

/** Welcome suggestion buttons prefill the composer with a starter prompt.
 *  While streaming the text is queued on Enter instead (follow-up path). */
function bindWelcomeSuggestions(): void {
    document.querySelectorAll('.welcome .wi:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', () => {
            const key = (btn as HTMLElement).dataset.suggestion;
            if (!key) return;
            const prompt = t(`welcome.${key}.prompt` as TextKey);
            const input = document.getElementById('input') as HTMLTextAreaElement | null;
            if (input) {
                input.value = prompt;
                input.style.height = 'auto';
            }
            if (state.isStreaming || !input) {
                input?.focus();
                return;
            }
            sendMessage();
        });
    });
}

function enterEditMode(turn: number, text: string, images: string[]): void {
    editingTurn = turn;
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    state.pendingImages = [...images];
    updateImageChips();
    if (input) {
        input.value = text;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }
    updateEditBanner();
}

function cancelEditMode(opts: { keepDraft?: boolean } = {}): void {
    if (editingTurn === null) return;
    editingTurn = null;
    updateEditBanner();
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    state.pendingImages = [];
    updateImageChips();
    if (input && !opts.keepDraft) {
        input.value = '';
        input.style.height = 'auto';
    }
}

function updateEditBanner(): void {
    const banner = document.getElementById('edit-banner');
    if (!banner) return;
    if (editingTurn === null) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }
    banner.style.display = '';
    banner.innerHTML = `
        <span class="edit-banner-label">&#9998; ${escHtml(t('edit.banner', { n: editingTurn }))}</span>
        <button class="edit-banner-cancel" title="${escHtml(t('edit.cancelTitle'))}">&#10005;</button>
    `;
    banner.querySelector('.edit-banner-cancel')?.addEventListener('click', () => cancelEditMode());
}

function bindDiffButtons(): void {
    document.querySelectorAll('.diff-file-header:not([data-bound])').forEach((header) => {
        header.setAttribute('data-bound', '1');
        header.addEventListener('click', () => {
            const filePath = (header as HTMLElement).dataset.filepath;
            const toolCallId = (header as HTMLElement).dataset.toolcallid;
            if (filePath && toolCallId) {
                vscode.postMessage({ type: 'openDiff', filePath, toolCallId });
            }
        });
    });
}

function bindToolClickable(): void {
    document.querySelectorAll('.tool-clickable:not([data-click-bound])').forEach((card) => {
        card.setAttribute('data-click-bound', '1');
        const headerEl = card.querySelector('.tool-header') as HTMLElement | null;
        if (!headerEl) return;
        const nameEl = headerEl.querySelector('.tool-name') as HTMLElement | null;
        if (!nameEl) return;
        nameEl.style.cursor = 'pointer';
        nameEl.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const filePath = (card as HTMLElement).dataset.filepath;
            if (filePath) {
                vscode.postMessage({ type: 'openFile', filePath });
            }
        });
    });
}

function bindChangedFileItems(): void {
    document.querySelectorAll('.changed-file-item:not([data-bound])').forEach((item) => {
        item.setAttribute('data-bound', '1');
        item.addEventListener('click', () => {
            const filePath = (item as HTMLElement).dataset.filepath;
            const toolCallId = (item as HTMLElement).dataset.toolcallid;
            if (filePath && toolCallId) {
                vscode.postMessage({ type: 'openDiff', filePath, toolCallId });
            }
        });
    });
}

function sendMessage(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;
    if (editingTurn !== null) {
        const replayText = input.value.trim();
        if (!replayText) return;
        if (state.isStreaming) {
            showError(t('edit.blockedStreaming'), ERROR_HINT_MS);
            return;
        }
        const turn = editingTurn;
        const images = state.pendingImages.length > 0 ? [...state.pendingImages] : undefined;
        cancelEditMode();
        userHasScrolled = false;
        updateScrollButton();
        historyReplacePending = { from: state.sessionId, rewrite: true };
        vscode.postMessage({ type: 'replayTurn', turn, text: replayText, images });
        return;
    }
    const text = input.value.trim();
    if (!text && state.pendingImages.length === 0 && state.pendingAttachments.length === 0) return;
    const images = state.pendingImages.length > 0 ? [...state.pendingImages] : undefined;
    const attachments =
        state.pendingAttachments.length > 0 ? [...state.pendingAttachments] : undefined;
    // Only refs still present in the draft as whole tokens are real; the rest
    // were deleted by the user while editing.
    const mentions = state.mentions.filter((tok) => hasMentionToken(text, tok));
    state.mentions = [];
    hideMentionMenu();
    if (state.isStreaming) {
        // Images and attachments can only ride a direct prompt. Streaming may
        // have started after they were attached (e.g. auto-compaction) —
        // refuse and keep the draft instead of silently dropping them.
        if (images || attachments) {
            showError(t('image.queueUnsupported'), ERROR_HINT_MS);
            return;
        }
        vscode.postMessage({ type: 'queueMessage', text });
        input.value = '';
        input.style.height = 'auto';
        userHasScrolled = false;
        updateScrollButton();
        return;
    }
    imageReadGeneration++;
    input.value = '';
    input.style.height = 'auto';
    state.pendingImages = [];
    state.pendingAttachments = [];
    updateImageChips();
    updateAttachChips();
    userHasScrolled = false;
    updateScrollButton();
    vscode.postMessage({
        type: 'prompt',
        text,
        images,
        mentions: mentions.length > 0 ? mentions : undefined,
        attachContents: attachments,
    });
}

let imageReadGeneration = 0;

/** Route picked/ dragged/ pasted files: images keep the image pipeline,
 *  non-image files are read as text and appended to the prompt. */
function addAttachments(files: File[]): void {
    const images = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));
    if (images.length > 0) {
        addImageFiles(images);
    }
    if (others.length > 0) {
        void addTextAttachments(others);
    }
}

/** Read non-image files as text and pin them to the composer (if readable). */
async function addTextAttachments(files: File[]): Promise<void> {
    if (state.isStreaming) {
        showNotice(t('attach.streamingUnsupported'));
        return;
    }
    for (const file of files) {
        if (file.size > MAX_ATTACH_FILE_BYTES) {
            showError(t('attach.tooLarge', { name: file.name }), ERROR_HINT_MS);
            continue;
        }
        try {
            const prefix = await file.slice(0, 8192).arrayBuffer();
            if (looksBinary(prefix)) {
                showNotice(t('attach.binaryUnsupported', { name: file.name }));
                continue;
            }
            state.pendingAttachments.push({
                name: file.name,
                content: normalizeAttachContent(await file.text()),
            });
            updateAttachChips();
        } catch {
            showNotice(t('attach.binaryUnsupported', { name: file.name }));
        }
    }
}

function addImageFiles(files: File[]): void {
    if (!state.supportsImages) {
        showNotice(t('image.unsupported'));
        return;
    }
    if (state.isStreaming) {
        showNotice(t('image.queueUnsupported'));
        return;
    }
    const candidates = files.filter((f) => f.type.startsWith('image/'));
    const slots = MAX_IMAGES_PER_PROMPT - state.pendingImages.length;
    if (candidates.length > slots) {
        showError(t('image.tooMany', { n: MAX_IMAGES_PER_PROMPT }), ERROR_HINT_MS);
    }
    const gen = imageReadGeneration;
    for (const file of candidates.slice(0, Math.max(0, slots))) {
        void normalizeImageFile(file).then((res) => {
            if (gen !== imageReadGeneration) return;
            if (!res.ok) {
                showError(
                    t(res.reason === 'tooLarge' ? 'image.tooLarge' : 'image.invalid'),
                    ERROR_HINT_MS,
                );
                return;
            }
            if (state.pendingImages.length >= MAX_IMAGES_PER_PROMPT) {
                showError(t('image.tooMany', { n: MAX_IMAGES_PER_PROMPT }), ERROR_HINT_MS);
                return;
            }
            if (file.size > MAX_IMAGE_BYTES) {
                showNotice(t('image.resized', { name: file.name }));
            }
            state.pendingImages.push(res.dataUrl);
            updateImageChips();
        });
    }
}

/** Copilot-style chip showing which editor selection rides the next prompt. */
function updateSelectionChip(): void {
    const chip = document.getElementById('selection-chip');
    if (!chip) return;
    const sel = state.selection;
    if (!sel) {
        chip.style.display = 'none';
        chip.innerHTML = '';
        return;
    }
    const range = sel.startLine === sel.endLine ? `${sel.startLine}` : `${sel.startLine}-${sel.endLine}`;
    chip.style.display = '';
    chip.innerHTML = `
        <svg class="selection-chip-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 2v12M12 2v12M4 4h8M4 12h8"/></svg>
        <span class="selection-chip-label">${escHtml(sel.path)}:${escHtml(range)}</span>
        <button class="selection-chip-close" title="${escHtml(t('selection.detach'))}">&#10005;</button>
    `;
    chip.querySelector('.selection-chip-close')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'dismissSelection' });
    });
}

function updateImageChips(): void {
    const container = document.getElementById('image-chips');
    if (!container) return;
    if (state.pendingImages.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    container.style.display = '';
    container.innerHTML = state.pendingImages
        .map(
            (src, i) => `
        <span class="image-chip">
            <img class="image-chip-thumb" src="${escAttr(src)}" alt="">
            <button class="image-chip-remove" data-index="${i}" title="${escHtml(t('image.remove'))}">&#10005;</button>
        </span>
    `,
        )
        .join('');
    container.querySelectorAll('.image-chip-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                state.pendingImages.splice(idx, 1);
                updateImageChips();
            }
        });
    });
}

function updateAttachChips(): void {
    const container = document.getElementById('attach-chips');
    if (!container) return;
    if (state.pendingAttachments.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    container.style.display = '';
    container.innerHTML = state.pendingAttachments
        .map(
            (a, i) => `
        <span class="attach-chip">
            <span class="attach-chip-name" title="${escAttr(a.name)}">${escHtml(a.name)}</span>
            <button class="attach-chip-remove" data-index="${i}" title="${escHtml(t('image.remove'))}">&#10005;</button>
        </span>
    `,
        )
        .join('');
    container.querySelectorAll('.attach-chip-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                state.pendingAttachments.splice(idx, 1);
                updateAttachChips();
            }
        });
    });
}

function bindCopyButtons(): void {
    document.querySelectorAll('.copy-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).dataset.codeId;
            if (!id) return;
            const codeEl = document.getElementById(id);
            if (!codeEl) return;
            navigator.clipboard.writeText(codeEl.textContent ?? '').then(() => {
                btn.textContent = t('code.copied');
                setTimeout(() => { btn.textContent = t('code.copy'); }, 1500);
            });
        });
    });
}

const APPLY_DEBOUNCE_MS = 5000;

function bindCodeBlockActions(): void {
    document.querySelectorAll('.apply-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', () => {
            const el0 = btn as HTMLElement;
            const id = el0.dataset.applyId;
            if (!id) return;
            const codeEl = document.getElementById(id);
            if (!codeEl) return;
            // 5s debounce: silently ignore repeated clicks (PRD 11.2).
            if (el0.hasAttribute('disabled')) return;
            el0.setAttribute('disabled', '');
            setTimeout(() => { el0.removeAttribute('disabled'); }, APPLY_DEBOUNCE_MS);
            vscode.postMessage({
                type: 'applyPreview',
                code: codeEl.textContent ?? '',
                lang: el0.dataset.applyLang ?? '',
            });
        });
    });

    document.querySelectorAll('.code-block-toggle:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', () => {
            const el0 = btn as HTMLElement;
            const id = el0.dataset.toggleId;
            if (!id) return;
            const wrapper = document.getElementById(id)?.closest('.code-block-wrapper');
            if (!wrapper) return;
            const collapsed = wrapper.classList.toggle('code-block-collapsed');
            el0.textContent = collapsed ? t('code.showMore') : t('code.showLess');
        });
    });
}

// ── Slash command menu ──

let slashMenuIndex = 0;
let slashMenuItems: CommandInfo[] = [];

function updateSlashMenu(input: HTMLTextAreaElement): void {
    const menu = document.getElementById('slash-menu');
    if (!menu) return;

    const text = input.value;
    const cursorPos = input.selectionStart;

    const beforeCursor = text.slice(0, cursorPos);
    const slashMatch = beforeCursor.match(/(?:^|\s)(\/\S*)$/);

    const allItems = buildSlashMenuItems();
    if (!slashMatch || allItems.length === 0) {
        hideSlashMenu();
        return;
    }

    const query = slashMatch[1].slice(1).toLowerCase();
    slashMenuItems = rankSlashMenuItems(allItems, query);

    if (slashMenuItems.length === 0) {
        hideSlashMenu();
        return;
    }

    slashMenuIndex = Math.min(slashMenuIndex, slashMenuItems.length - 1);
    renderSlashMenu(menu);
    menu.style.display = '';
}

function buildSlashMenuItems(): CommandInfo[] {
    const items: CommandInfo[] = [];
    // Skills first
    for (const s of state.skills) {
        items.push({
            name: s.name,
            description: s.description,
            source: 'skill',
            label: `/skill:${s.name}`,
        });
    }
    // Then commands
    for (const c of state.commands) {
        items.push({
            ...c,
            label: c.label ?? `/${c.name}`,
        });
    }
    return items;
}

function renderSlashMenu(menu: HTMLElement): void {
    menu.innerHTML = slashMenuItems.map((item, i) => {
        const active = i === slashMenuIndex ? ' slash-item-active' : '';
        const desc = item.description
            ? `<span class="slash-item-desc">${escHtml(item.description)}</span>`
            : '';
        return `<div class="slash-item${active}" data-index="${i}">
            <span class="slash-item-name">${escHtml(item.label ?? `/${item.name}`)}</span>
            ${desc}
        </div>`;
    }).join('');

    menu.querySelectorAll('.slash-item').forEach((item) => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const idx = parseInt((item as HTMLElement).dataset.index ?? '0', 10);
            selectSlashItem(idx);
        });
    });
}

function selectSlashItem(index: number): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;

    const item = slashMenuItems[index];
    if (!item) return;

    const text = input.value;
    const cursorPos = input.selectionStart;
    const beforeCursor = text.slice(0, cursorPos);
    const slashMatch = beforeCursor.match(/(?:^|\s)(\/\S*)$/);

    if (slashMatch) {
        const matchStart = beforeCursor.length - slashMatch[1].length;
        const replacement = `${item.label ?? `/${item.name}`} `;
        input.value = text.slice(0, matchStart) + replacement + text.slice(cursorPos);
        const newPos = matchStart + replacement.length;
        input.setSelectionRange(newPos, newPos);
    }

    hideSlashMenu();
    input.focus();
}

function hideSlashMenu(): void {
    const menu = document.getElementById('slash-menu');
    if (menu) {
        menu.style.display = 'none';
        menu.innerHTML = '';
    }
    slashMenuItems = [];
    slashMenuIndex = 0;
}

function isSlashMenuVisible(): boolean {
    const menu = document.getElementById('slash-menu');
    return !!menu && menu.style.display !== 'none' && slashMenuItems.length > 0;
}

// ── @-mention completion menu ──

interface MentionMenuItem {
    token: string;
    label: string;
    desc: string;
}

let mentionMenuIndex = 0;
let mentionFiles: string[] = [];
let mentionSymbols: MentionSymbolItem[] = [];
let mentionAnchor = -1;
let mentionQuerySeq = 0;
let mentionPendingRequestId = -1;
let dropPendingRequestId = -1;
let mentionDebounce: ReturnType<typeof setTimeout> | undefined;

/** The active `@query` fragment ending at the caret, or null. */
function getMentionFragment(input: HTMLTextAreaElement): { anchor: number; query: string } | null {
    const cursor = input.selectionStart ?? input.value.length;
    const beforeCursor = input.value.slice(0, cursor);
    const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) return null;
    return { anchor: beforeCursor.length - match[1].length - 1, query: match[1] };
}

function updateMentionMenu(input: HTMLTextAreaElement): void {
    const fragment = getMentionFragment(input);
    if (!fragment) {
        cancelMentionQuery();
        hideMentionMenu();
        return;
    }
    mentionAnchor = fragment.anchor;
    if (mentionDebounce) clearTimeout(mentionDebounce);
    const seq = ++mentionQuerySeq;
    mentionDebounce = setTimeout(() => {
        mentionPendingRequestId = seq;
        vscode.postMessage({ type: 'mentionQuery', query: fragment.query, requestId: seq });
    }, 120);
}

function cancelMentionQuery(): void {
    if (mentionDebounce) clearTimeout(mentionDebounce);
    mentionDebounce = undefined;
    mentionPendingRequestId = -1;
    mentionAnchor = -1;
}

function buildMentionMenuItems(): MentionMenuItem[] {
    const files = mentionFiles.map((p) => ({ token: p, label: p, desc: '' }));
    const symbols = mentionSymbols.map((s) => ({
        token: `${s.path}:${s.line}`,
        label: s.name,
        desc: `${s.kind} · ${s.path}:${s.line}`,
    }));
    return [...files, ...symbols];
}

function renderMentionMenu(): void {
    const menu = document.getElementById('mention-menu');
    if (!menu) return;
    const items = buildMentionMenuItems();
    if (items.length === 0) {
        menu.innerHTML = `<div class="mention-item-empty">${escHtml(t('mention.noResults'))}</div>`;
        mentionMenuIndex = 0;
        menu.style.display = '';
        return;
    }
    mentionMenuIndex = Math.min(mentionMenuIndex, items.length - 1);
    const renderRange = (list: MentionMenuItem[], offset: number) =>
        list.map((item, i) => renderMentionItem(item, offset + i)).join('');
    const fileGroup = mentionFiles.length > 0
        ? `<div class="mention-group">${escHtml(t('mention.groupFiles'))}</div>`
        : '';
    const symbolGroup = mentionSymbols.length > 0
        ? `<div class="mention-group">${escHtml(t('mention.groupSymbols'))}</div>`
        : '';
    menu.innerHTML =
        fileGroup +
        renderRange(items.slice(0, mentionFiles.length), 0) +
        symbolGroup +
        renderRange(items.slice(mentionFiles.length), mentionFiles.length);
    menu.querySelectorAll('.mention-item').forEach((node) => {
        node.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const idx = parseInt((node as HTMLElement).dataset.index ?? '0', 10);
            selectMentionItem(idx);
        });
    });
    menu.style.display = '';
}

function renderMentionItem(item: MentionMenuItem, i: number): string {
    const active = i === mentionMenuIndex ? ' mention-item-active' : '';
    const desc = item.desc ? `<span class="mention-item-desc">${escHtml(item.desc)}</span>` : '';
    return `<div class="mention-item${active}" data-index="${i}">
        <span class="mention-item-name">@${escHtml(item.label)}</span>
        ${desc}
    </div>`;
}

function selectMentionItem(index: number): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;
    // The anchor may be stale if the caret moved since the popup opened
    // (e.g. a click elsewhere). Revalidate against the live fragment.
    const fragment = getMentionFragment(input);
    if (!fragment) {
        cancelMentionQuery();
        hideMentionMenu();
        return;
    }
    mentionAnchor = fragment.anchor;
    const item = buildMentionMenuItems()[index];
    if (!item) return;
    const cursor = input.selectionStart ?? input.value.length;
    const replacement = `@${item.token} `;
    input.value = input.value.slice(0, mentionAnchor) + replacement + input.value.slice(cursor);
    const newPos = mentionAnchor + replacement.length;
    input.setSelectionRange(newPos, newPos);
    if (!state.mentions.includes(item.token)) state.mentions.push(item.token);
    cancelMentionQuery();
    hideMentionMenu();
    input.focus();
}

/** Insert a dropped file's reference at the caret (AC-FN-21): the token
 *  joins state.mentions so the host expands it exactly like @-mention. */
function insertMentionTokenAtCursor(token: string): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const replacement = `@${token} `;
    input.value = input.value.slice(0, start) + replacement + input.value.slice(end);
    const newPos = start + replacement.length;
    input.setSelectionRange(newPos, newPos);
    if (!state.mentions.includes(token)) state.mentions.push(token);
    input.focus();
}
function hideMentionMenu(): void {
    const menu = document.getElementById('mention-menu');
    if (menu) {
        menu.style.display = 'none';
        menu.innerHTML = '';
    }
    mentionFiles = [];
    mentionSymbols = [];
    mentionMenuIndex = 0;
}

function isMentionMenuVisible(): boolean {
    const menu = document.getElementById('mention-menu');
    // A "no results" hint must not swallow Enter — only real items do.
    return !!menu && menu.style.display !== 'none' && buildMentionMenuItems().length > 0;
}

// ── Helpers ──

let userHasScrolled = false;
let isProgrammaticScroll = false;

function scrollToBottom(force = false): void {
    if (userHasScrolled && !force) return;
    const messages = document.getElementById('messages');
    if (messages) {
        isProgrammaticScroll = true;
        // Forced jumps (open/load/switch) land instantly — the container's
        // CSS smooth animation across a long history reads as "stuck at top".
        messages.scrollTo({ top: messages.scrollHeight, behavior: force ? 'instant' : 'auto' });
    }
}

function isNearBottom(): boolean {
    const messages = document.getElementById('messages');
    if (!messages) return true;
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 50;
}

function updateScrollButton(): void {
    const btn = document.getElementById('btn-scroll-bottom');
    if (!btn) return;
    if (userHasScrolled) {
        btn.classList.add('visible');
    } else {
        btn.classList.remove('visible');
    }
}

function bindScrollListener(): void {
    const messages = document.getElementById('messages');
    if (!messages) return;

    // Detect user-initiated scroll intent immediately
    messages.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) {
            userHasScrolled = true;
            updateScrollButton();
        }
    }, { passive: true });

    messages.addEventListener('touchstart', () => {
        userHasScrolled = true;
        updateScrollButton();
    }, { passive: true });

    // The scroll event handles both taking control and resetting.
    // Manual scrolling must always beat auto-scroll: the instant the user
    // moves away from the bottom, auto-scroll cedes priority.
    messages.addEventListener('scroll', () => {
        if (isProgrammaticScroll) {
            isProgrammaticScroll = false;
            return;
        }
        if (isNearBottom()) {
            userHasScrolled = false;
        } else {
            userHasScrolled = true;
        }
        updateScrollButton();
    });
}

// ── Init ──
// Preload the markdown engine chunk in parallel with the shell render so the
// first content frame can highlight immediately.
void prepareMarkdown();
render();
// The host pushes the full snapshot when it resolves the view, but those
// posts race the document reload whenever VS Code re-creates the webview
// (hide/show) and can be lost entirely — leaving a welcome screen with no
// conversation until the next state change. The webview knows when its own
// script is live, so it asks for the snapshot itself; marking it as a
// history replace lands the restoring frame on the newest message.
historyReplacePending = { from: state.sessionId, rewrite: true };
vscode.postMessage({ type: 'getState' });
vscode.postMessage({ type: 'getSkills' });
