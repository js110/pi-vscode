import type { ClientMessage, ServerMessage, SerializedAgentState, FileChangeInfo, TabInfo, ToolCallPendingInfo, SkillInfo, CommandInfo, PiConfigSnapshot, ApprovalScope, ApplyPreviewInfo, Lang, MentionSymbolItem, PlanSnapshot, PlanStepStatus } from '../shared/protocol';
import { PLAN_DANGEROUS_REASON } from '../shared/protocol';
import { isDangerousTool } from '../shared/tool-safety';
import { splitStreamBlocks, computeUnchangedPrefix } from '../shared/stream-blocks';
import { MAX_IMAGES_PER_PROMPT, MAX_IMAGE_BYTES } from '../shared/image-input';
import { t, setLang } from '../shared/i18n';
import { hasMentionToken } from '../shared/mention';
import { parseUriList } from '../shared/drop-files';
import { formatTerminalQuote } from '../shared/terminal-quote';
import { escAttr, formatTimestamp, formatTokenCount, truncate, tryParseJSON, extractText, extractThinking, extractToolResultText, formatToolArgs, buildStatusHtml, getToolIcon, getToolLabel, getFileIcon, renderDiffLines } from '../shared/webview-text';
import { el, escHtml } from './dom';
import { renderMarkdown, buildWelcome, buildThinkingBlock, thinkingLabel, buildDiffCard, buildToolCard, buildModelItem, buildApprovalBadge, resetCodeBlockIds } from './render/messages';

declare function acquireVsCodeApi(): {
    postMessage(message: ClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();
const iconsBaseUri = document.getElementById('app')?.dataset.iconsUri ?? '';

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
    supportsImages: boolean;
    mentions: string[];
    plan: PlanSnapshot | null;
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
    supportsImages: false,
    mentions: [],
    plan: null,
};

let sessionSearchQuery = '';

// ── Message handling ──

window.addEventListener('message', (event) => {
    handleMessage(event.data as ServerMessage);
});

function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
        case 'ready':
            vscode.postMessage({ type: 'getState' });
            vscode.postMessage({ type: 'getSkills' });
            break;
        case 'stateSync':
            applyStateSync(msg.state);
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
            applyMemoryBadge(document.getElementById(`tool-${msg.toolCallId}`) as HTMLElement | null, msg.toolCallId);
            break;
        }
        case 'skills':
            state.skills = msg.skills;
            state.commands = msg.commands ?? [];
            break;
        case 'configState':
            state.config = msg.config;
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
                showError(t('compact.failed'));
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
        case 'terminalQuoted':
            if (msg.requestId !== terminalQuotePendingRequestId) break;
            terminalQuotePendingRequestId = -1;
            if (msg.result.ok) {
                insertTerminalQuoteAtCursor(formatTerminalQuote(msg.result.entry));
            } else {
                showError(t(`terminal.${msg.result.reason}`));
            }
            break;
        case 'error':
            showError(msg.message);
            break;
    }
}

function handleConfirmResult(action: string, confirmed: boolean, payload?: any): void {
    if (!confirmed) return;
    switch (action) {
        case 'restoreCheckpoint':
            if (payload?.messageIndex !== undefined) {
                vscode.postMessage({ type: 'restoreCheckpoint', messageIndex: payload.messageIndex });
            }
            break;
        case 'redoCheckpoint':
            vscode.postMessage({ type: 'redoCheckpoint' });
            break;
    }
}

function applyStateSync(s: SerializedAgentState): void {
    const prevTab = state.activeTabId;
    state.messages = s.messages ?? [];
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
    state.plan = s.plan ?? null;
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
        state.mentions = [];
        hideMentionMenu();
        dropPendingRequestId = -1;
    }

    if (tabSwitched || !skeletonBuilt) {
        render();
        userHasScrolled = false;
        scrollToBottom(true);
        updateScrollButton();
    } else {
        updateTabs();
        updateStreamingUI();
        updateMessages();
        updateInputArea();
        updateChangedFiles();
        updateQueuedMessageBanner();
        updateCompactionBanner();
        updatePlanCard();
        updateImageChips();
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
            updateStreamingUI();
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
            updateStreamingUI();
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
            updateStreamingUI();
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

    // Header: tab-strip (dynamic) + header-right (static)
    const header = el('div', 'header');
    const tabStrip = el('div', 'tab-strip');
    header.appendChild(tabStrip);
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
    header.appendChild(headerActions);
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

    // Input container: changed-files slot + compaction banner + queued section + slash menu + input-area (persistent textarea) + footer
    const inputContainer = el('div', 'input-container');
    const compactionBanner = el('div', 'compaction-banner');
    compactionBanner.id = 'compaction-banner';
    compactionBanner.style.display = 'none';
    inputContainer.appendChild(compactionBanner);
    const planCard = el('div', 'plan-card');
    planCard.id = 'plan-card';
    planCard.style.display = 'none';
    inputContainer.appendChild(planCard);
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
    const imageChips = el('div', 'image-chips');
    imageChips.id = 'image-chips';
    imageChips.style.display = 'none';
    inputContainer.appendChild(imageChips);
    const imageFileInput = document.createElement('input');
    imageFileInput.type = 'file';
    imageFileInput.id = 'image-file-input';
    imageFileInput.accept = 'image/*';
    imageFileInput.multiple = true;
    imageFileInput.style.display = 'none';
    inputContainer.appendChild(imageFileInput);
    const area = el('div', 'input-area');
    area.innerHTML = `<textarea id="input" placeholder="${escHtml(t('input.ask'))}" rows="1"></textarea>`;
    inputContainer.appendChild(area);
    const footer = el('div', 'input-footer');
    inputContainer.appendChild(footer);
    app.appendChild(inputContainer);

    // Bind stable event listeners (these elements persist for the lifetime of the skeleton)
    bindStableEvents();
    bindScrollListener();
    scrollBtn.addEventListener('click', () => {
        userHasScrolled = false;
        scrollToBottom(true);
        updateScrollButton();
    });

    skeletonBuilt = true;

    // Populate all dynamic sections
    updateTabs();
    updateMessages();
    updateInputArea();
    updateChangedFiles();
    updateCompactionBanner();
    updatePlanCard();
    updateImageChips();
    scrollToBottom();
}

function updateMessages(): void {
    const container = document.getElementById('messages');
    if (!container) return;

    const streamingEl = document.getElementById('streaming-message');
    const spacerEl = container.querySelector('.messages-spacer');

    // Remove all children before #streaming-message (the message nodes)
    while (container.firstChild && container.firstChild !== streamingEl) {
        container.removeChild(container.firstChild);
    }

    resetCodeBlockIds();

    if (state.messages.length === 0 && !state.isStreaming) {
        container.insertBefore(buildWelcome(), streamingEl);
    } else {
        let userMsgCount = 0;
        const rollbackUserIdx = state.rollbackPoint;
        let dimming = false;
        let redoPlaced = false;
        let lastUserGroup: HTMLElement | null = null;

        for (let i = 0; i < state.messages.length; i++) {
            const msg = state.messages[i];
            const role = msg.role ?? 'unknown';

            if (role === 'user') {
                userMsgCount++;
                if (rollbackUserIdx !== null && userMsgCount > rollbackUserIdx) {
                    dimming = true;
                }
            }

            const msgEl = renderMessage(msg, i, role === 'user' ? userMsgCount : undefined);
            if (dimming) {
                msgEl.classList.add('dimmed');
            }

            container.insertBefore(msgEl, streamingEl);

            if (role === 'user' && !dimming) {
                lastUserGroup = msgEl;
            }

            if (role === 'user' && dimming && !redoPlaced && rollbackUserIdx !== null) {
                const redoWrap = el('div', 'redo-anchor');
                const redoBtn = el('button', 'redo-btn');
                redoBtn.title = t('files.redoTitle');
                redoBtn.textContent = t('files.redo');
                redoWrap.appendChild(redoBtn);
                container.insertBefore(redoWrap, streamingEl);
                redoPlaced = true;
            }
        }

        if (lastUserGroup) {
            lastUserGroup.classList.add('message-group-user-latest');
        }
    }

    bindCopyButtons();
    bindCodeBlockActions();
    bindCheckpointButtons();
    bindRedoButtons();
    bindDiffButtons();
    bindToolClickable();
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

function updateInputArea(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (input) {
        const inputHint = state.isStreaming ? t('input.queue') : t('input.ask');
        input.placeholder = inputHint;
        input.title = inputHint;
        input.setAttribute('aria-label', inputHint);
    }

    const footer = document.querySelector('.input-footer');
    if (!footer) return;
    footer.classList.toggle('input-footer-streaming', state.isStreaming);

    const modelName = state.model?.name ?? state.model?.id ?? '';

    let contextHtml = '';
    if (state.contextUsage) {
        const cu = state.contextUsage;
        const tokensK = cu.tokens != null ? formatTokenCount(cu.tokens) : null;
        const windowK = formatTokenCount(cu.contextWindow);
        const pct = cu.percent != null ? Math.round(cu.percent) : null;
        if (tokensK !== null && pct !== null) {
            contextHtml = `<span class="footer-context" title="${escAttr(t('input.contextTooltip', { tokens: tokensK, window: windowK, percent: pct }))}">${tokensK} / ${windowK} &middot; ${pct}%</span>`;
        } else {
            contextHtml = `<span class="footer-context" title="${escAttr(t('input.contextWindowTooltip', { window: windowK }))}">${windowK}</span>`;
        }
    }

    const steerBtnHtml = state.isStreaming
        ? `<button id="btn-steer" class="steer-btn" title="${escHtml(t('input.steer'))}"><svg class="steer-icon-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6l4-4 4 4M4 10l4 4 4-4"/></svg></button>`
        : '';

    const attachBtnHtml = state.supportsImages && !state.isStreaming
        ? `<button id="btn-attach" class="attach-btn" title="${escHtml(t('image.attach'))}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 7.2l-5.3 5.3a3.4 3.4 0 0 1-4.8-4.8l5.4-5.4a2.3 2.3 0 0 1 3.2 3.2L6.6 10.9a1.15 1.15 0 0 1-1.6-1.6l4.9-4.9"/></svg></button>`
        : '';

    const quoteTerminalBtnHtml = `<button id="btn-quote-terminal" class="attach-btn" title="${escHtml(t('terminal.quote'))}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3h11v8.5h-11z"/><path d="M4.5 5.5L6.5 7.5L4.5 9.5M7.5 9.5h4"/></svg></button>`;

    const planPhase = state.plan?.phase ?? 'off';
    const planToggleable = planPhase === 'off' || planPhase === 'planning' || planPhase === 'awaitingApproval';
    const planBtnHtml = `<button id="btn-plan" class="plan-btn${planPhase !== 'off' ? ' active' : ''}"${planToggleable ? '' : ' disabled'} title="${escHtml(t('plan.modeTitle'))}">${escHtml(t('plan.mode'))}</button>`;

    footer.innerHTML = `
        <span class="footer-model">${escHtml(modelName)}</span>
        <span class="footer-spacer"></span>
        ${contextHtml}
        ${planBtnHtml}
        ${state.isStreaming ? `<button id="btn-abort" class="abort-btn" title="${escHtml(t('input.stop'))}">&#9632; ${escHtml(t('input.stop'))}</button>` : ''}
        ${steerBtnHtml}
        ${attachBtnHtml}
        ${quoteTerminalBtnHtml}
        <button id="btn-send" class="send-btn" title="${escHtml(state.isStreaming ? t('input.queueSend') : t('input.send'))}"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3L8 13M8 3L3 8M8 3L13 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
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

    const quoteTerminalBtn = document.getElementById('btn-quote-terminal');
    quoteTerminalBtn?.addEventListener('click', () => {
        terminalQuotePendingRequestId = ++mentionQuerySeq;
        vscode.postMessage({ type: 'terminalQuote', requestId: terminalQuotePendingRequestId });
    });

    const planBtn = document.getElementById('btn-plan');
    planBtn?.addEventListener('click', () => {
        const phase = state.plan?.phase ?? 'off';
        if (phase === 'off') {
            vscode.postMessage({ type: 'planStart' });
        } else if (phase === 'planning' || phase === 'awaitingApproval') {
            vscode.postMessage({ type: 'planCancel' });
        }
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

// ── Plan card (PRD C8/C9) ──

function planStepIcon(status: PlanStepStatus): string {
    switch (status) {
        case 'running': return '<span class="plan-step-icon running">&#9684;</span>';
        case 'done': return '<span class="plan-step-icon done">&#10003;</span>';
        case 'failed': return '<span class="plan-step-icon failed">&#10007;</span>';
        case 'cancelled': return '<span class="plan-step-icon cancelled">&#8212;</span>';
        default: return '<span class="plan-step-icon pending">&#9675;</span>';
    }
}

function movePlanStep(from: number, to: number): void {
    const plan = state.plan;
    if (!plan) return;
    const titles = plan.steps.map((s) => s.title);
    if (from < 0 || from >= titles.length || to < 0 || to >= titles.length) return;
    const [moved] = titles.splice(from, 1);
    titles.splice(to, 0, moved);
    vscode.postMessage({ type: 'planSetSteps', titles });
}

function updatePlanCard(): void {
    const card = document.getElementById('plan-card');
    if (!card) return;
    const plan = state.plan;
    if (!plan || plan.phase === 'off') {
        card.style.display = 'none';
        card.innerHTML = '';
        return;
    }
    card.style.display = '';

    const stepsHtml = (editable: boolean) => plan.steps.map((step, i) => {
        const actions = editable
            ? `<span class="plan-step-actions">
                <button class="plan-step-btn plan-step-up" data-index="${i}" title="${escHtml(t('plan.stepUp'))}"${i === 0 ? ' disabled' : ''}>&#8593;</button>
                <button class="plan-step-btn plan-step-down" data-index="${i}" title="${escHtml(t('plan.stepDown'))}"${i === plan.steps.length - 1 ? ' disabled' : ''}>&#8595;</button>
                <button class="plan-step-btn plan-step-remove" data-index="${i}" title="${escHtml(t('plan.stepRemove'))}">&#10005;</button>
            </span>`
            : '';
        return `<div class="plan-step plan-step-${step.status}" data-index="${i}">
            ${planStepIcon(step.status)}
            <span class="plan-step-title">${escHtml(step.title)}</span>
            ${actions}
        </div>`;
    }).join('');

    let body = '';
    switch (plan.phase) {
        case 'planning':
            body = `
                <div class="plan-card-header"><span class="plan-spinner"></span>${escHtml(t('plan.planning'))}</div>
                <div class="plan-card-actions">
                    <button class="plan-btn plan-secondary" id="plan-cancel">${escHtml(t('plan.cancel'))}</button>
                </div>`;
            break;
        case 'awaitingApproval': {
            const canApprove = plan.steps.length > 0;
            body = `
                <div class="plan-card-header">${escHtml(t('plan.awaiting'))}</div>
                <div class="plan-steps">${stepsHtml(true)}</div>
                <div class="plan-card-actions">
                    <button class="plan-btn plan-secondary" id="plan-replan">${escHtml(t('plan.replan'))}</button>
                    <button class="plan-btn plan-primary" id="plan-approve"${canApprove ? '' : ' disabled'}>${escHtml(t('plan.approve'))}</button>
                </div>`;
            break;
        }
        case 'executing':
            body = `
                <div class="plan-card-header">${escHtml(t('plan.executing'))}</div>
                <div class="plan-steps">${stepsHtml(false)}</div>
                <div class="plan-card-hint">${escHtml(t('plan.escHint'))}</div>`;
            break;
        case 'paused': {
            const reason = plan.pausedReason === PLAN_DANGEROUS_REASON
                ? t('plan.pausedDangerous')
                : t('plan.pausedStep', { reason: plan.pausedReason ?? '' });
            body = `
                <div class="plan-card-header paused">${escHtml(t('plan.paused'))}</div>
                <div class="plan-card-hint">${escHtml(reason)}</div>
                <div class="plan-steps">${stepsHtml(false)}</div>
                <div class="plan-card-actions">
                    <button class="plan-btn plan-primary" id="plan-resume">${escHtml(t('plan.resume'))}</button>
                    <button class="plan-btn plan-secondary" id="plan-adjust">${escHtml(t('plan.adjust'))}</button>
                    <button class="plan-btn plan-danger" id="plan-abandon">${escHtml(t('plan.abandon'))}</button>
                </div>`;
            break;
        }
        case 'done':
            body = `
                <div class="plan-card-header done">${escHtml(t('plan.done'))}</div>
                <div class="plan-steps">${stepsHtml(false)}</div>
                <div class="plan-card-actions">
                    <button class="plan-btn plan-secondary" id="plan-close">${escHtml(t('plan.close'))}</button>
                </div>`;
            break;
        case 'interrupted': {
            const done = plan.steps.filter((s) => s.status === 'done').length;
            body = `
                <div class="plan-card-header paused">${escHtml(t('plan.interrupted', { done, total: plan.steps.length }))}</div>
                <div class="plan-steps">${stepsHtml(false)}</div>
                <div class="plan-card-actions">
                    <button class="plan-btn plan-primary" id="plan-restart">${escHtml(t('plan.replan'))}</button>
                    <button class="plan-btn plan-secondary" id="plan-close">${escHtml(t('plan.close'))}</button>
                </div>`;
            break;
        }
    }
    card.innerHTML = body;
    bindPlanCard();
}

function bindPlanCard(): void {
    const post = (message: ClientMessage) => vscode.postMessage(message);
    document.getElementById('plan-cancel')?.addEventListener('click', () => post({ type: 'planCancel' }));
    document.getElementById('plan-replan')?.addEventListener('click', () => post({ type: 'planReplan' }));
    document.getElementById('plan-approve')?.addEventListener('click', () => post({ type: 'planApprove' }));
    document.getElementById('plan-resume')?.addEventListener('click', () => post({ type: 'planResume' }));
    document.getElementById('plan-abandon')?.addEventListener('click', () => post({ type: 'planAbandon' }));
    document.getElementById('plan-restart')?.addEventListener('click', () => post({ type: 'planStart' }));
    document.getElementById('plan-adjust')?.addEventListener('click', () => {
        const plan = state.plan;
        if (!plan) return;
        post({ type: 'planAdjust', titles: plan.steps.map((s) => s.title) });
    });
    document.querySelectorAll('#plan-card #plan-close').forEach((btn) =>
        btn.addEventListener('click', () => post({ type: 'planClose' })));
    document.querySelectorAll('#plan-card .plan-step-up').forEach((btn) =>
        btn.addEventListener('click', () => {
            const i = Number((btn as HTMLElement).dataset.index);
            movePlanStep(i, i - 1);
        }));
    document.querySelectorAll('#plan-card .plan-step-down').forEach((btn) =>
        btn.addEventListener('click', () => {
            const i = Number((btn as HTMLElement).dataset.index);
            movePlanStep(i, i + 1);
        }));
    document.querySelectorAll('#plan-card .plan-step-remove').forEach((btn) =>
        btn.addEventListener('click', () => {
            const plan = state.plan;
            const i = Number((btn as HTMLElement).dataset.index);
            if (!plan) return;
            post({ type: 'planSetSteps', titles: plan.steps.map((s) => s.title).filter((_, j) => j !== i) });
        }));
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
    streamBlocks = [];
}

function dismissSteerToast(): void {
    const toast = document.getElementById('steer-toast');
    if (!toast) return;
    toast.classList.add('steer-toast-fade');
    setTimeout(() => toast.remove(), 300);
}

// ── Changed Files section ──

function buildChangedFilesSection(): HTMLElement {
    const details = document.createElement('details');
    details.className = 'changed-files-section';
    details.id = 'changed-files-bar';

    const fileMap = new Map<string, FileChangeInfo>();
    for (const c of state.fileChanges) {
        fileMap.set(c.filePath, c);
    }
    const uniqueFiles = [...fileMap.values()];
    const count = uniqueFiles.length;

    const summary = document.createElement('summary');
    summary.className = 'changed-files-summary';
    const undoRedoBtn = state.rollbackPoint !== null
        ? `<button class="changed-files-link" id="btn-redo" title="${escHtml(t('files.redoTitle'))}">${escHtml(t('files.redo'))}</button>`
        : `<button class="changed-files-link" id="btn-undo" title="${escHtml(t('files.undoTitle'))}">${escHtml(t('files.undo'))}</button>`;
    summary.innerHTML = `
        <span class="changed-files-arrow">&#9656;</span>
        <span class="changed-files-count">${escHtml(t('files.count', { n: count, s: count !== 1 ? 's' : '' }))}</span>
        <span class="changed-files-spacer"></span>
        ${undoRedoBtn}
        <button class="changed-files-review-btn" id="btn-review-all" title="${escHtml(t('files.reviewTitle'))}">${escHtml(t('files.review'))}</button>
    `;
    details.appendChild(summary);

    const list = el('div', 'changed-files-list');
    for (const change of uniqueFiles) {
        const fileName = change.filePath.split('/').pop() ?? change.filePath;
        const item = el('div', 'changed-file-item');
        item.dataset.filepath = change.filePath;
        item.dataset.toolcallid = change.toolCallId;

        let statsHtml = '';
        if (change.addedLines > 0) statsHtml += `<span class="cf-stat-add">+${change.addedLines}</span>`;
        if (change.removedLines > 0) statsHtml += `<span class="cf-stat-del">-${change.removedLines}</span>`;

        item.innerHTML = `
            <span class="cf-icon">${getFileIcon(change.filePath)}</span>
            <span class="cf-name">${escHtml(fileName)}</span>
            <span class="cf-stats">${statsHtml}</span>
        `;
        list.appendChild(item);
    }
    details.appendChild(list);

    return details;
}

function updateChangedFiles(): void {
    const container = document.querySelector('.input-container');
    if (!container) return;

    const existing = document.getElementById('changed-files-bar') as HTMLDetailsElement | null;
    const wasOpen = existing?.open ?? false;

    if (state.fileChanges.length === 0) {
        existing?.remove();
        return;
    }

    const newSection = buildChangedFilesSection();
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
            countEl.textContent = t('files.count', { n: count, s: count !== 1 ? 's' : '' });
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

function renderMessage(msg: any, index: number, turnNumber?: number): HTMLElement {
    const role = msg.role ?? 'unknown';

    if (role === 'toolResult' || role === 'tool') {
        const toolName = msg.toolName ?? '';
        if (toolName === 'edit' || toolName === 'write') {
            const matchingChange = findFileChangeForToolResult(msg);
            if (matchingChange) {
                return buildDiffCard(matchingChange, msg);
            }
        }
        return buildToolResultCard(msg, state.messages, index);
    }

    if (role === 'user') {
        const group = el('div', 'message-group-user');

        const wrapper = el('div', `message message-${role}`);
        if (turnNumber !== undefined && !state.isStreaming) {
            const checkpointBtn = el('button', 'checkpoint-btn');
            checkpointBtn.title = t('checkpoint.restore');
            checkpointBtn.dataset.turn = String(turnNumber);
            checkpointBtn.innerHTML = '&#8634;';
            wrapper.appendChild(checkpointBtn);
        }
        const text = extractText(msg);
        if (text) {
            const content = el('div', 'message-content');
            content.innerHTML = renderMarkdown(text);
            wrapper.appendChild(content);
        }
        for (const src of extractUserImages(msg)) {
            const img = el('img', 'message-image') as HTMLImageElement;
            img.src = src;
            img.alt = '';
            wrapper.appendChild(img);
        }
        group.appendChild(wrapper);

        const footer = buildMessageFooter(msg, index);
        if (footer) {
            group.appendChild(footer);
        }

        return group;
    }

    // Assistant messages: wrap in a styled container
    const thinking = extractThinking(msg);
    const text = extractText(msg);

    if (!thinking && !text) {
        const empty = el('div');
        empty.style.display = 'none';
        return empty;
    }

    const group = el('div', 'message-group-assistant');

    const wrapper = el('div', `message message-${role}`);

    if (thinking) {
        wrapper.appendChild(buildThinkingBlock(thinking, false, msg._thinkingDurationSec));
    }

    if (text) {
        const content = el('div', 'message-content');
        content.innerHTML = renderMarkdown(text);
        wrapper.appendChild(content);
    }

    group.appendChild(wrapper);

    const footer = buildMessageFooter(msg, index);
    if (footer) {
        group.appendChild(footer);
    }

    return group;
}

function extractToolCalls(msg: any): any[] {
    if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) return msg.toolCalls;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return msg.tool_calls;
    if (Array.isArray(msg.content)) {
        const tcs = msg.content.filter((c: any) => c.type === 'toolCall' || c.type === 'tool_call' || c.type === 'tool_use');
        if (tcs.length > 0) return tcs;
    }
    return [];
}

function findFileChangeForToolResult(msg: any): FileChangeInfo | undefined {
    const id = msg.toolCallId ?? msg.tool_call_id;
    if (id) {
        const match = state.fileChanges.find(c => c.toolCallId === id);
        if (match) return match;
    }
    return undefined;
}

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

function renderStreamingContent(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    if (!state.streamingText && !state.streamingThinking) return;
    removePreparingPlaceholder();

    if (!container.querySelector('.message')) {
        streamBlocks = [];
        container.innerHTML = `
            <div class="message message-assistant">
                <details class="thinking-block active" open id="streaming-thinking" style="display:none">
                    <summary class="thinking-summary">
                        <span class="thinking-indicator"></span>
                        <span class="thinking-label"></span>
                        <span class="thinking-chevron">&#9656;</span>
                    </summary>
                    <div class="thinking-content"></div>
                </details>
                <div class="message-content" id="streaming-text"></div>
            </div>
        `;
    }

    const thinkingEl = document.getElementById('streaming-thinking') as HTMLDetailsElement | null;
    if (thinkingEl) {
        if (state.streamingThinking) {
            thinkingEl.style.display = '';
            const contentEl = thinkingEl.querySelector('.thinking-content');
            if (contentEl) contentEl.innerHTML = renderMarkdown(state.streamingThinking);
            const labelEl = thinkingEl.querySelector('.thinking-label');
            if (labelEl) labelEl.textContent = thinkingLabel(state.isThinking, state.streamingThinkingDuration);
            if (state.isThinking) {
                thinkingEl.classList.add('active');
            } else {
                thinkingEl.classList.remove('active');
            }
        } else {
            thinkingEl.style.display = 'none';
        }
    }

    const textEl = document.getElementById('streaming-text');
    if (textEl) {
        patchStreamingTextBlocks(textEl);
    }

    bindCopyButtons();
    bindCodeBlockActions();
    scrollToBottom();
}

// Block-level incremental render (PRD C4): only blocks after the unchanged
// prefix are re-parsed and re-rendered on each delta.
let streamBlocks: string[] = [];

function patchStreamingTextBlocks(textEl: HTMLElement): void {
    const next = splitStreamBlocks(state.streamingText);
    let from = computeUnchangedPrefix(streamBlocks, next);
    if (textEl.children.length !== streamBlocks.length) {
        from = 0; // DOM desynced (rebuilt skeleton) — patch everything
    }

    while (textEl.children.length > next.length) {
        textEl.lastElementChild?.remove();
    }
    for (let i = from; i < next.length; i++) {
        let blockEl = textEl.children[i] as HTMLElement | undefined;
        if (!blockEl) {
            blockEl = el('div', 'stream-block');
            textEl.appendChild(blockEl);
        }
        blockEl.innerHTML = renderMarkdown(next[i]);
    }
    streamBlocks = next;
}

// ── Tool rendering ──

function buildToolFooter(msg: any, allMessages: any[], msgIndex: number): HTMLElement | null {
    const parts: string[] = [];
    const ts = msg.timestamp;
    if (ts) parts.push(formatTimestamp(ts));

    const precedingAssistant = findPrecedingAssistant(allMessages, msgIndex);
    if (precedingAssistant?.usage) {
        const u = precedingAssistant.usage;
        if (u.input > 0) parts.push(t('meta.tokensIn', { n: u.input.toLocaleString() }));
        if (u.output > 0) parts.push(t('meta.tokensOut', { n: u.output.toLocaleString() }));
    }

    if (parts.length === 0) return null;
    const footer = el('div', 'tool-footer');
    footer.textContent = parts.join(' · ');
    return footer;
}

function findPrecedingAssistant(messages: any[], beforeIndex: number): any | null {
    for (let i = beforeIndex - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') return messages[i];
        if (messages[i].role === 'user') return null;
    }
    return null;
}

function buildToolResultCard(msg: any, allMessages: any[], msgIndex: number): HTMLElement {
    const isError = msg.isError ?? false;
    const toolName = msg.toolName ?? '';
    const toolCallId = msg.toolCallId ?? '';
    const nameLower = toolName.toLowerCase();

    const matchingCall = findToolCallInMessages(allMessages, msgIndex, toolCallId);
    const args = matchingCall?.arguments ?? matchingCall?.args ?? matchingCall?.input ?? {};
    const parsedArgs = typeof args === 'string' ? tryParseJSON(args) : args;
    const label = toolName ? getToolLabel(toolName, parsedArgs) : t('tool.result');
    const icon = getToolIcon(toolName ?? '');
    const isBash = nameLower === 'bash';
    const isRead = nameLower === 'read';
    const filePath = parsedArgs?.path ?? parsedArgs?.file_path ?? '';

    const resultContent = extractText(msg);
    const hasBody = !!(resultContent || isBash) && !isRead;

    const footer = buildToolFooter(msg, allMessages, msgIndex);

    if (hasBody) {
        const wrapper = el('div', 'tool-card-wrapper');

        const details = document.createElement('details');
        details.className = 'tool-card tool-expandable';

        details.innerHTML = `
            <summary class="tool-header">
                <span class="tool-icon">${icon}</span>
                <span class="tool-name">${escHtml(label)}</span>
                ${buildStatusHtml(isError ? 'error' : 'done')}
                <span class="tool-expand-arrow">&#9656;</span>
            </summary>
        `;

        const body = el('div', 'tool-body');
        const result = el('pre', 'tool-result');
        result.textContent = resultContent || t('tool.noOutput');
        if (!resultContent) result.classList.add('empty');
        body.appendChild(result);
        details.appendChild(body);
        wrapper.appendChild(details);

        applyMemoryBadge(details, toolCallId);
        if (footer) wrapper.appendChild(footer);
        return wrapper;
    }

    const wrapper = el('div', 'tool-card-wrapper');

    const card = el('div', `tool-card${isRead ? ' tool-clickable' : ''}`);
    if (isRead && filePath) card.dataset.filepath = filePath;

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${icon}</span>
            <span class="tool-name">${escHtml(label)}</span>
            ${buildStatusHtml(isError ? 'error' : 'done')}
        </div>
    `;

    wrapper.appendChild(card);
    applyMemoryBadge(card, toolCallId);
    if (footer) wrapper.appendChild(footer);
    return wrapper;
}

function findToolCallInMessages(messages: any[], beforeIndex: number, toolCallId: string): any | undefined {
    if (!toolCallId) return undefined;
    for (let i = beforeIndex - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'assistant') continue;
        const tcs = extractToolCalls(m);
        for (const tc of tcs) {
            if ((tc.id ?? tc.toolCallId) === toolCallId) return tc;
        }
    }
    return undefined;
}

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
        applyMemoryBadge(card, event.toolCallId);
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

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(event.toolName)}</span>
            <span class="tool-name">${escHtml(getToolLabel(event.toolName, parsedArgs))}</span>
            <span class="tool-status running">${escHtml(t('tool.running'))}</span>
        </div>
    `;

    container.appendChild(card);
    applyMemoryBadge(card, event.toolCallId);
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
        applyMemoryBadge(details, event.toolCallId);
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

function applyMemoryBadge(card: HTMLElement | null, toolCallId: string): void {
    const scope = state.approvalTraces.get(toolCallId);
    if (!card || !scope) return;
    const header = card.querySelector('.tool-header, .diff-file-header');
    if (!header || header.querySelector('.memory-badge')) return;
    const status = header.querySelector('.tool-status');
    const badge = buildApprovalBadge(scope);
    if (status) {
        header.insertBefore(badge, status);
    } else {
        header.appendChild(badge);
    }
}

function renderToolApprovalCard(pending: ToolCallPendingInfo): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    removePreparingPlaceholder();

    const existing = document.getElementById(`approval-${pending.toolCallId}`);
    if (existing) return;

    if (!state.pendingApprovals.some(p => p.toolCallId === pending.toolCallId)) {
        state.pendingApprovals.push(pending);
    }

    const card = el('div', 'tool-approval-card');
    card.id = `approval-${pending.toolCallId}`;

    const parsedArgs = typeof pending.args === 'string' ? tryParseJSON(pending.args) : pending.args;
    const label = getToolLabel(pending.toolName, parsedArgs);

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(pending.toolName)}</span>
            <span class="tool-name">${escHtml(label)}</span>
            <span class="tool-status pending">${escHtml(t('approval.awaiting'))}</span>
        </div>
        <div class="approval-args">${escHtml(formatToolArgs(parsedArgs))}</div>
        <div class="approval-actions">
            <button class="approval-btn approve" data-toolcallid="${escHtml(pending.toolCallId)}">${escHtml(t('approval.approve'))}</button>
            ${isDangerousTool(pending.toolName) ? '' : `
            <span class="remember-split">
                <button class="approval-btn remember" data-toolcallid="${escHtml(pending.toolCallId)}">${escHtml(t('approval.remember'))}</button>
                <div class="remember-menu" hidden>
                    <div class="remember-option" data-toolcallid="${escHtml(pending.toolCallId)}" data-scope="session">${escHtml(t('approval.rememberSession'))}</div>
                    <div class="remember-option" data-toolcallid="${escHtml(pending.toolCallId)}" data-scope="global">${escHtml(t('approval.rememberGlobal'))}</div>
                </div>
            </span>`}
            <button class="approval-btn reject" data-toolcallid="${escHtml(pending.toolCallId)}">${escHtml(t('approval.reject'))}</button>
        </div>
    `;

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

    const fileName = preview.targetPath.split(/[\\/]/).pop() ?? preview.targetPath;
    const dirPath = preview.targetPath.split(/[\\/]/).slice(0, -1).join('/');

    let statsHtml = '';
    if (preview.addedLines > 0 || preview.removedLines > 0) {
        statsHtml = `<span class="diff-stats">`;
        if (preview.addedLines > 0) statsHtml += `<span class="diff-stat-add">+${preview.addedLines}</span>`;
        if (preview.removedLines > 0) statsHtml += `<span class="diff-stat-del">-${preview.removedLines}</span>`;
        statsHtml += `</span>`;
    }

    const card = el('div', 'tool-approval-card apply-preview-card');
    card.id = `apply-preview-${preview.previewId}`;
    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${preview.isNew ? '&#10010;' : '&#9998;'}</span>
            <span class="tool-name">${escHtml(t('apply.title', { path: fileName }))}</span>
            ${dirPath ? `<span class="diff-file-dir">${escHtml(dirPath)}</span>` : ''}
            ${statsHtml}
            ${preview.isNew ? `<span class="diff-new-badge">${escHtml(t('apply.newFileBadge'))}</span>` : ''}
        </div>
        <div class="diff-view apply-diff-view">${preview.diff ? renderDiffLines(preview.diff) : ''}</div>
        <div class="approval-actions">
            <button class="approval-btn approve apply-confirm" data-previewid="${escAttr(preview.previewId)}">${escHtml(t('apply.confirm'))}</button>
            <button class="approval-btn reject apply-cancel" data-previewid="${escAttr(preview.previewId)}">${escHtml(t('apply.cancel'))}</button>
        </div>
    `;

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
    const container = document.getElementById('messages');
    if (!container) return;
    const toast = el('div', 'notice-toast');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
    scrollToBottom();
}

// ── Thinking block ──

// ── Model picker popup ──

let pendingModelPicker = false;

function toggleModelPicker(): void {
    const existing = document.getElementById('model-picker');
    if (existing) {
        existing.remove();
        pendingModelPicker = false;
        return;
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

function buildConfigBanner(): HTMLElement | null {
    const config = state.config;
    if (!config) return null;

    const banner = el('div', 'config-banner');
    if (config.status === 'not-found') {
        const msg = el('div', 'config-issue');
        msg.textContent = t('config.notFound', { dir: config.agentDir });
        banner.appendChild(msg);
    } else {
        const stats = el('div', 'config-stats');
        stats.textContent = t('config.stats', {
            providers: t('config.providerCount', { n: config.providers.length, s: config.providers.length === 1 ? '' : 's' }),
            models: t('config.modelCount', { n: config.models.length, s: config.models.length === 1 ? '' : 's' }),
            skills: t('config.skillCount', { n: config.skills.length, s: config.skills.length === 1 ? '' : 's' }),
        });
        banner.appendChild(stats);
        if (config.status === 'partial' || config.status === 'error') {
            const issue = el('div', 'config-issue');
            issue.textContent = config.errors[0]
                ? t('config.issue', { source: config.errors[0].source, message: config.errors[0].message })
                : t('config.issueFallback');
            banner.appendChild(issue);
        }
    }

    const refresh = el('button', 'config-refresh');
    refresh.textContent = t('config.recheck');
    refresh.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'refreshConfig' });
    });
    banner.appendChild(refresh);
    return banner;
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

    const configBanner = buildConfigBanner();
    if (configBanner) picker.appendChild(configBanner);

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
        const q = searchInput.value.toLowerCase();
        list.querySelectorAll('.model-item').forEach((item) => {
            const name = (item as HTMLElement).dataset.name ?? '';
            (item as HTMLElement).style.display = name.includes(q) ? '' : 'none';
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
        panel.innerHTML = `<div class="session-empty">${escHtml(t('sessions.empty'))}</div>`;
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

function showError(message: string): void {
    const container = document.getElementById('messages');
    if (!container) return;
    const errEl = el('div', 'error-message');
    errEl.textContent = message;
    container.appendChild(errEl);
    scrollToBottom();
}

function updateStreamingUI(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    container.innerHTML = '';
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
            addImageFiles(Array.from(fileInput.files));
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
            addImageFiles(files);
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
        const files = Array.from(dt?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (files.length > 0) {
            addImageFiles(files);
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
    const text = input.value.trim();
    if (!text && state.pendingImages.length === 0) return;
    const images = state.pendingImages.length > 0 ? [...state.pendingImages] : undefined;
    // Only refs still present in the draft as whole tokens are real; the rest
    // were deleted by the user while editing.
    const mentions = state.mentions.filter((tok) => hasMentionToken(text, tok));
    state.mentions = [];
    hideMentionMenu();
    if (state.isStreaming) {
        // Images can only ride a direct prompt. Streaming may have started
        // after they were attached (e.g. auto-compaction) — refuse and keep
        // the draft instead of silently dropping them.
        if (images) {
            showError(t('image.queueUnsupported'));
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
    updateImageChips();
    userHasScrolled = false;
    updateScrollButton();
    vscode.postMessage({
        type: 'prompt',
        text,
        images,
        mentions: mentions.length > 0 ? mentions : undefined,
    });
}

let imageReadGeneration = 0;

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
        showError(t('image.tooMany', { n: MAX_IMAGES_PER_PROMPT }));
    }
    const gen = imageReadGeneration;
    for (const file of candidates.slice(0, Math.max(0, slots))) {
        if (file.size > MAX_IMAGE_BYTES) {
            showError(t('image.tooLarge'));
            continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
            if (gen !== imageReadGeneration) return;
            const dataUrl = String(reader.result ?? '');
            if (!dataUrl.startsWith('data:image/')) {
                showError(t('image.invalid'));
                return;
            }
            if (state.pendingImages.length >= MAX_IMAGES_PER_PROMPT) {
                showError(t('image.tooMany', { n: MAX_IMAGES_PER_PROMPT }));
                return;
            }
            state.pendingImages.push(dataUrl);
            updateImageChips();
        };
        reader.readAsDataURL(file);
    }
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

/** Image attachments on a persisted user message (pi ImageContent items). */
function extractUserImages(msg: any): string[] {
    if (!Array.isArray(msg.content)) return [];
    const sources: string[] = [];
    for (const c of msg.content) {
        if ((c.type !== 'image' && c.type !== 'image_url') || c.data == null) continue;
        const mime =
            typeof c.mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(c.mimeType)
                ? c.mimeType
                : 'image/png';
        sources.push(`data:${mime};base64,${String(c.data).replace(/[^A-Za-z0-9+/=]/g, '')}`);
    }
    return sources;
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
    slashMenuItems = allItems.filter(item =>
        item.name.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query)
    );

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
let terminalQuotePendingRequestId = -1;
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

/** Insert quoted terminal output at the caret (AC-FN-23): plain text
 *  (pre-fenced), deliberately not registered as an @-mention token. */
function insertTerminalQuoteAtCursor(text: string): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const needsLeadingNewline = start > 0 && input.value[start - 1] !== '\n';
    const replacement = `${needsLeadingNewline ? '\n' : ''}${text.trimEnd()}\n`;
    input.value = input.value.slice(0, start) + replacement + input.value.slice(end);
    const newPos = start + replacement.length;
    input.setSelectionRange(newPos, newPos);
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

function buildMessageFooter(msg: any, index: number): HTMLElement | null {
    const role = msg.role ?? 'unknown';
    if (role !== 'user' && role !== 'assistant') return null;

    const parts: string[] = [];

    const ts = msg.timestamp;
    if (ts) {
        parts.push(formatTimestamp(ts));
    }

    if (role === 'user') {
        // Show input tokens from the next assistant message's usage
        for (let j = index + 1; j < state.messages.length; j++) {
            const next = state.messages[j];
            if (next.role === 'assistant' && next.usage && next.usage.input > 0) {
                parts.push(t('meta.inputTokens', { n: next.usage.input.toLocaleString() }));
                break;
            }
            if (next.role === 'user') break;
        }
    }

    if (role === 'assistant') {
        if (msg._messageEndTime && msg.timestamp) {
            const startMs = msg.timestamp < 1e12 ? msg.timestamp * 1000 : msg.timestamp;
            const durationSec = (msg._messageEndTime - startMs) / 1000;
            const usage = msg.usage;
            if (usage && usage.output > 0 && durationSec > 0) {
                const tokPerSec = usage.output / durationSec;
                parts.push(`${tokPerSec.toFixed(1)} tok/s`);
            }
        }

        const usage = msg.usage;
        if (usage && usage.output > 0) {
            parts.push(t('meta.outputTokens', { n: usage.output.toLocaleString() }));
        }
    }

    if (parts.length === 0) return null;

    const footer = el('div', 'message-footer');
    footer.textContent = parts.join(' · ');
    return footer;
}

let userHasScrolled = false;
let isProgrammaticScroll = false;

function scrollToBottom(force = false): void {
    if (userHasScrolled && !force) return;
    const messages = document.getElementById('messages');
    if (messages) {
        isProgrammaticScroll = true;
        messages.scrollTop = messages.scrollHeight;
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
render();
