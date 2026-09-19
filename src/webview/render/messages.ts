// Deep module for building message/render DOM.
//
// The message builders are pure: given inputs (plus the shared DOM helpers),
// they return detached HTMLElement nodes, hold no state, touch no `vscode`
// API, and produce no side effects, which makes them unit-testable under
// happy-dom. main.ts assembles the MessageRenderState context and performs
// placement, event binding, and state side effects.
//
// The streaming region is the one exception. It is rendered by reconcilers
// (`updateStreamingThinking` / `reconcileStreamingText`, plus the pure
// `buildStreamingSkeleton`) that mutate an already-mounted node in place to
// avoid re-rendering the whole markdown blob each frame. `reconcileStreamingText`
// keys a per-element block cache in a WeakMap so repeated frames patch only the
// changed tail; that cache is the only module state here (alongside the
// markdown renderer's block-id counter), and it is keyed by element so it
// disappears with the node.
import type { FileChangeInfo, ApprovalScope, ToolCallPendingInfo, ApplyPreviewInfo, PiConfigSnapshot } from '../../shared/protocol';
import { t, type TextKey } from '../../shared/i18n';
import { isDangerousTool } from '../../shared/tool-safety';
import { splitStreamBlocks, computeUnchangedPrefix } from '../../shared/stream-blocks';
import {
    escAttr,
    formatTimestamp,
    tryParseJSON,
    extractText,
    extractThinking,
    formatToolArgs,
    buildStatusHtml,
    getToolIcon,
    getToolLabel,
    getFileIcon,
    renderDiffLines,
} from '../../shared/webview-text';
import { el, escHtml } from '../dom';

// ── Markdown rendering ──
//
// The marked + highlight.js engine lives in its own module (`./markdown`) so
// the bundler can split it into a lazy chunk. `prepareMarkdown()` loads it
// once (memoized module singleton); the sync `renderMarkdown` below uses the
// engine whenever it is ready and falls back to plain escaped text otherwise,
// so renderers stay synchronous. main.ts awaits `prepareMarkdown()` before the
// first content render, which makes the fallback unreachable in production.

export interface MarkdownEngine {
    render(text: string): string;
    reset(): void;
}

let markdownEngine: MarkdownEngine | undefined;
let markdownEnginePromise: Promise<MarkdownEngine> | undefined;

/** Load and memoize the markdown engine chunk. Safe to call repeatedly. */
export function prepareMarkdown(): Promise<MarkdownEngine> {
    if (!markdownEnginePromise) {
        markdownEnginePromise = import('./markdown').then((mod) => {
            const engine: MarkdownEngine = {
                render: (text) => mod.renderMarkdownWithEngine(text),
                // eslint-disable-next-line @typescript-eslint/no-misused-promises
                reset: () => mod.resetEngineCodeBlockIds(),
            };
            markdownEngine = engine;
            return engine;
        });
    }
    return markdownEnginePromise;
}

function renderMarkdownFallback(text: string): string {
    return `<div class="message-content-plain">${escHtml(text)}</div>`;
}

export function renderMarkdown(text: string): string {
    if (!text) return '';
    if (markdownEngine) return markdownEngine.render(text);
    return renderMarkdownFallback(text);
}

export function resetCodeBlockIds(): void {
    // Per-frame code-block id reset; only the engine allocates ids.
    markdownEngine?.reset();
}

// ── Streaming region ──

/** The live assistant bubble the streaming engine keeps in sync. Reconciles
 *  against streaming state; frames and deltas converge to the same DOM. */
export function buildStreamingSkeleton(): HTMLElement {
    const msg = el('div', 'message message-assistant');
    const thinking = document.createElement('details');
    thinking.className = 'thinking-block active';
    thinking.id = 'streaming-thinking';
    thinking.style.display = 'none';
    thinking.open = true;
    thinking.innerHTML = `
        <summary class="thinking-summary">
            <span class="thinking-indicator"></span>
            <span class="thinking-label"></span>
            <span class="thinking-chevron">&#9656;</span>
        </summary>
        <div class="thinking-content"></div>
    `;
    const text = el('div', 'message-content');
    text.id = 'streaming-text';
    msg.appendChild(thinking);
    msg.appendChild(text);
    return msg;
}

/** Syncs an existing streaming-thinking block (hidden/show, label, content,
 *  active class) from the current streaming state. Pure w.r.t. the given
 *  element. */
export function updateStreamingThinking(
    thinkingEl: HTMLElement | null,
    opts: { thinking: string; isThinking: boolean; durationSec: number },
): void {
    if (!thinkingEl) return;
    const contentEl = thinkingEl.querySelector('.thinking-content');
    const labelEl = thinkingEl.querySelector('.thinking-label');
    if (opts.thinking) {
        thinkingEl.style.display = '';
        if (contentEl) contentEl.innerHTML = renderMarkdown(opts.thinking);
        if (labelEl) labelEl.textContent = thinkingLabel(opts.isThinking, opts.durationSec);
        thinkingEl.classList.toggle('active', opts.isThinking);
    } else {
        thinkingEl.style.display = 'none';
    }
}

// Block-level incremental render (PRD C4): only blocks after the unchanged
// prefix are re-parsed and re-rendered on each delta. The block cache is keyed
// by the live element so a rebuilt skeleton (or new session) starts fresh
// automatically and stale caches die with their element.
const streamingTextCache = new WeakMap<HTMLElement, string[]>();

/** Reconciles the streaming text container with the current full text: keeps
 *  every block up to the unchanged prefix, patches only the tail, and prunes
 *  removed blocks. Idempotent — calling it with any prefix of the text yields
 *  the correct converging DOM. */
export function reconcileStreamingText(textEl: HTMLElement, text: string): void {
    const next = splitStreamBlocks(text);
    const prev = streamingTextCache.get(textEl) ?? [];
    const from = computeUnchangedPrefix(prev, next);

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
    streamingTextCache.set(textEl, next);
}

// ── Static view builders ──

/** Welcome suggestions: key feeds `welcome.<key>.title/.desc/.prompt`. */
const WELCOME_SUGGESTIONS = [
    { key: 'sug1', icon: '✳' },
    { key: 'sug2', icon: '▤' },
    { key: 'sug3', icon: '◈' },
    { key: 'sug4', icon: '↯' },
];

export function buildWelcome(): HTMLElement {
    const w = el('div', 'welcome');
    const items = WELCOME_SUGGESTIONS.map(
        (s) => `
        <button class="wi" type="button" data-suggestion="${s.key}">
            <span class="wi-ic">${s.icon}</span>
            <span class="wi-t">${escHtml(t(`welcome.${s.key}.title` as TextKey))}</span>
            <span class="wi-d">${escHtml(t(`welcome.${s.key}.desc` as TextKey))}</span>
        </button>`,
    ).join('');
    w.innerHTML = `
        <div class="w-pi">&pi;</div>
        <div class="welcome-title">${escHtml(t('welcome.headline'))}</div>
        <div class="welcome-subtitle">${escHtml(t('welcome.subtitle'))}</div>
        <div class="w-items">${items}</div>
        <div class="w-hint">${t('welcome.hintShort')}</div>
    `;
    return w;
}

export function thinkingLabel(active: boolean, durationSec?: number): string {
    if (active) return t('stream.thinking');
    if (durationSec && durationSec > 0) {
        const key = durationSec === 1 ? 'stream.thoughtForOne' : 'stream.thoughtForMany';
        return t(key, { n: durationSec });
    }
    return t('stream.thought');
}

export function buildThinkingBlock(text: string, active: boolean, durationSec?: number): HTMLElement {
    const details = document.createElement('details');
    details.className = `thinking-block${active ? ' active' : ''}`;
    const label = thinkingLabel(active, durationSec);
    details.innerHTML = `
        <summary class="thinking-summary">
            <span class="thinking-indicator"></span>
            <span class="thinking-label">${escHtml(label)}</span>
            <span class="thinking-chevron">&#9656;</span>
        </summary>
        <div class="thinking-content">${renderMarkdown(text)}</div>
    `;
    return details;
}

/** `+N / -M` stat pills shared by the diff and apply-preview cards. */
function diffStatsHtml(addedLines: number, removedLines: number): string {
    if (addedLines <= 0 && removedLines <= 0) return '';
    const add = addedLines > 0 ? `<span class="diff-stat-add">+${addedLines}</span>` : '';
    const del = removedLines > 0 ? `<span class="diff-stat-del">-${removedLines}</span>` : '';
    return `<span class="diff-stats">${add}${del}</span>`;
}

export function buildDiffCard(change: FileChangeInfo, msg?: any): HTMLElement {
    const wrapper = el('div', 'tool-card-wrapper');

    const card = el('div', 'diff-card');
    card.id = `diff-${change.toolCallId}`;

    const fileName = change.filePath.split('/').pop() ?? change.filePath;
    const dirPath = change.filePath.split('/').slice(0, -1).join('/');
    const statsHtml = diffStatsHtml(change.addedLines, change.removedLines);

    card.innerHTML = `
        <div class="diff-file-header" data-filepath="${escAttr(change.filePath)}" data-toolcallid="${escAttr(change.toolCallId)}">
            <span class="diff-file-icon">${change.isNew ? '&#10010;' : '&#9998;'}</span>
            <span class="diff-file-name">${escHtml(fileName)}</span>
            ${dirPath ? `<span class="diff-file-dir">${escHtml(dirPath)}</span>` : ''}
            ${statsHtml}
            ${change.isNew ? `<span class="diff-new-badge">${escHtml(t('diff.new'))}</span>` : ''}
        </div>
    `;

    if (change.diff) {
        const diffView = el('div', 'diff-view');
        diffView.innerHTML = renderDiffLines(change.diff);
        card.appendChild(diffView);
    }

    wrapper.appendChild(card);

    const ts = msg?.timestamp;
    if (ts) {
        const footer = el('div', 'tool-footer');
        footer.textContent = formatTimestamp(ts);
        wrapper.appendChild(footer);
    }

    return wrapper;
}

/** Badge marking a tool card as auto-approved by approval memory (PRD 9.3). */
export function buildApprovalBadge(scope: string): HTMLElement {
    const badge = el('span', 'memory-badge');
    badge.textContent = scope === 'global' ? t('approval.memoryGlobal') : t('approval.memorySession');
    return badge;
}

/** Inserts the approval-memory badge into a tool/diff card header when the
 *  toolCallId has a remembered scope. Pure: reads the traces map it is given. */
export function applyMemoryBadge(card: HTMLElement | null, toolCallId: string, approvalTraces: Map<string, ApprovalScope>): void {
    const scope = approvalTraces.get(toolCallId);
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

export function buildModelItem(m: any, currentModel?: { provider: string; id: string; name?: string }): HTMLElement {
    const item = el('div', 'model-item');
    const isActive = currentModel && m.id === currentModel.id && m.provider === currentModel.provider;
    if (isActive) item.classList.add('active');
    item.dataset.provider = m.provider;
    item.dataset.modelId = m.id;
    item.dataset.name = (m.name ?? m.id).toLowerCase();
    item.innerHTML = `
        <span class="model-item-check">${isActive ? '&#10003;' : ''}</span>
        <span class="model-item-name">${escHtml(m.name ?? m.id)}</span>
    `;
    return item;
}

// ── Message tree ──

/** The full slice of webview state the message render tree consumes. Assembled
 *  by main.ts; the render module stays agnostic of the global `state` object. */
export interface MessageRenderState {
    messages: any[];
    isStreaming: boolean;
    fileChanges: FileChangeInfo[];
    imageCache: Record<string, string>;
    rollbackPoint: number | null;
    approvalTraces: Map<string, ApprovalScope>;
}

export function buildMessageTree(ctx: MessageRenderState): HTMLElement[] {
    if (ctx.messages.length === 0 && !ctx.isStreaming) {
        return [buildWelcome()];
    }

    const nodes: HTMLElement[] = [];
    let userMsgCount = 0;
    const rollbackUserIdx = ctx.rollbackPoint;
    let dimming = false;
    let redoPlaced = false;

    for (let i = 0; i < ctx.messages.length; i++) {
        const msg = ctx.messages[i];
        const role = msg.role ?? 'unknown';

        if (role === 'user') {
            userMsgCount++;
            if (rollbackUserIdx !== null && userMsgCount > rollbackUserIdx) {
                dimming = true;
            }
        }

        const msgEl = buildMessage(msg, i, role === 'user' || role === 'assistant' ? userMsgCount : undefined, ctx);
        if (dimming) {
            msgEl.classList.add('dimmed');
        }
        nodes.push(msgEl);

        // Place the redo anchor right after the first dimmed user message
        // (hidden until a redo checkpoint becomes available).
        if (role === 'user' && dimming && !redoPlaced && rollbackUserIdx !== null) {
            const redoWrap = el('div', 'redo-anchor');
            const redoBtn = el('button', 'redo-btn');
            redoBtn.title = t('files.redoTitle');
            redoBtn.textContent = t('files.redo');
            redoWrap.appendChild(redoBtn);
            nodes.push(redoWrap);
            redoPlaced = true;
        }
    }
    return nodes;
}

/** π rail marker sitting on the gutter line, with an optional turn head.
 *  The head (who + turn number) renders only at the start of a new assistant
 *  turn; continuation blocks just get the π marker. */
function buildTurnMarker(turnNumber: number | undefined, isTurnStart: boolean): HTMLElement {
    const holder = el('div', 'turn-marker');
    const av = el('span', 'turn-av');
    av.textContent = 'π';
    holder.appendChild(av);
    if (isTurnStart) {
        const head = el('div', 'turn-head');
        const who = el('span', 'who');
        who.textContent = t('msg.pi');
        head.appendChild(who);
        if (turnNumber !== undefined) {
            const no = el('span', 'turn-no');
            no.textContent = t('msg.turn', { n: turnNumber });
            head.appendChild(no);
        }
        holder.appendChild(head);
    }
    return holder;
}

/** Compact "Me" avatar chip above the user bubble. Hidden while streaming so
 *  the active turn keeps its π marker as the sole rail decoration. */
function buildUserHead(isStreaming: boolean): HTMLElement | null {
    if (isStreaming) return null;
    const head = el('div', 'user-head');
    const av = el('span', 'u-av');
    av.textContent = t('msg.me');
    head.appendChild(av);
    return head;
}

function buildMessage(msg: any, index: number, turnNumber: number | undefined, ctx: MessageRenderState): HTMLElement {
    const role = msg.role ?? 'unknown';

    if (role === 'toolResult' || role === 'tool') {
        const toolName = msg.toolName ?? '';
        if (toolName === 'edit' || toolName === 'write') {
            const matchingChange = findFileChangeForToolResult(msg, ctx.fileChanges);
            if (matchingChange) {
                return buildDiffCard(matchingChange, msg);
            }
        }
        return buildToolCard(msg, { allMessages: ctx.messages, msgIndex: index, approvalTraces: ctx.approvalTraces });
    }

    if (role === 'user') {
        const group = el('div', 'message-group-user turn turn-user');
        const head = buildUserHead(ctx.isStreaming);
        if (head) {
            group.appendChild(head);
        }

        const wrapper = el('div', `message message-${role}`);
        if (turnNumber !== undefined && !ctx.isStreaming) {
            const checkpointBtn = el('button', 'checkpoint-btn');
            checkpointBtn.title = t('checkpoint.restore');
            checkpointBtn.dataset.turn = String(turnNumber);
            checkpointBtn.innerHTML = '&#8634;';
            wrapper.appendChild(checkpointBtn);
            const regenBtn = el('button', 'regen-btn');
            regenBtn.title = t('msg.replayTitle');
            regenBtn.dataset.turn = String(turnNumber);
            regenBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"/><path d="M13.5 1.5v3.5h-3.5"/></svg>';
            wrapper.appendChild(regenBtn);
            const editBtn = el('button', 'edit-btn');
            editBtn.title = t('msg.editTitle');
            editBtn.dataset.turn = String(turnNumber);
            editBtn.innerHTML = '&#9998;';
            wrapper.appendChild(editBtn);
        }
        const text = extractText(msg);
        if (text) {
            const content = el('div', 'message-content');
            content.innerHTML = renderMarkdown(text);
            wrapper.appendChild(content);
        }
        for (const src of extractUserImages(msg, ctx.imageCache)) {
            const img = el('img', 'message-image') as HTMLImageElement;
            img.src = src;
            img.alt = '';
            wrapper.appendChild(img);
        }
        group.appendChild(wrapper);

        const footer = buildMessageFooter(msg, ctx.messages, index);
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

    const group = el('div', 'message-group-assistant turn turn-assistant');

    const isTurnStart = index === 0 || (ctx.messages[index - 1]?.role ?? 'unknown') !== 'assistant';
    group.appendChild(buildTurnMarker(turnNumber, isTurnStart));

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

    const footer = buildMessageFooter(msg, ctx.messages, index);
    if (footer) {
        group.appendChild(footer);
    }

    return group;
}

/** Image attachments on a persisted user message. The host ships base64
 *  payloads once via stateSync.images; messages carry assetId references. */
function extractUserImages(msg: any, imageCache: Record<string, string>): string[] {
    if (!Array.isArray(msg.content)) return [];
    const sources: string[] = [];
    for (const c of msg.content) {
        if ((c.type !== 'image' && c.type !== 'image_url') || c.assetId == null) continue;
        const dataUrl = imageCache[c.assetId];
        if (dataUrl) sources.push(dataUrl);
    }
    return sources;
}

function findFileChangeForToolResult(msg: any, fileChanges: FileChangeInfo[]): FileChangeInfo | undefined {
    const id = msg.toolCallId ?? msg.tool_call_id;
    if (id) {
        const match = fileChanges.find(c => c.toolCallId === id);
        if (match) return match;
    }
    return undefined;
}

export function buildMessageFooter(msg: any, messages: any[], index: number): HTMLElement | null {
    const role = msg.role ?? 'unknown';
    if (role !== 'user' && role !== 'assistant') return null;

    const parts: string[] = [];

    const ts = msg.timestamp;
    if (ts) {
        parts.push(formatTimestamp(ts));
    }

    if (role === 'user') {
        // Show input tokens from the next assistant message's usage
        for (let j = index + 1; j < messages.length; j++) {
            const next = messages[j];
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

// ── Tool cards ──

function extractToolCalls(msg: any): any[] {
    if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) return msg.toolCalls;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return msg.tool_calls;
    if (Array.isArray(msg.content)) {
        const tcs = msg.content.filter((c: any) => c.type === 'toolCall' || c.type === 'tool_call' || c.type === 'tool_use');
        if (tcs.length > 0) return tcs;
    }
    return [];
}

function findPrecedingAssistant(messages: any[], beforeIndex: number): any | null {
    for (let i = beforeIndex - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') return messages[i];
        if (messages[i].role === 'user') return null;
    }
    return null;
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

/** Shared tool-header inner spans (icon + name + status). Live cards build a
 *  header element from this; settled cards inline the same HTML. */
function buildToolCardHeaderHtml(toolName: string, label: string, statusHtml: string): string {
    return `<span class="tool-icon">${getToolIcon(toolName)}</span><span class="tool-name">${escHtml(label)}</span>${statusHtml}`;
}

export function buildToolCardHeader(toolName: string, label: string, statusHtml: string): HTMLElement {
    const header = el('div', 'tool-header');
    header.innerHTML = buildToolCardHeaderHtml(toolName, label, statusHtml);
    return header;
}

export interface ToolCardContext {
    allMessages: any[];
    msgIndex: number;
    approvalTraces: Map<string, ApprovalScope>;
}

/** Settled tool-result card: expandable body for bash/edit-with-output, compact
 *  header for read-only tools. Merges the two historical variants into one
 *  builder and applies the approval-memory badge when a trace is present. */
export function buildToolCard(msg: any, ctx: ToolCardContext): HTMLElement {
    const isError = msg.isError ?? false;
    const toolName = msg.toolName ?? '';
    const toolCallId = msg.toolCallId ?? '';
    const nameLower = toolName.toLowerCase();

    const matchingCall = findToolCallInMessages(ctx.allMessages, ctx.msgIndex, toolCallId);
    const args = matchingCall?.arguments ?? matchingCall?.args ?? matchingCall?.input ?? {};
    const parsedArgs = typeof args === 'string' ? tryParseJSON(args) : args;
    const label = toolName ? getToolLabel(toolName, parsedArgs) : t('tool.result');
    const isBash = nameLower === 'bash';
    const isRead = nameLower === 'read';
    const filePath = parsedArgs?.path ?? parsedArgs?.file_path ?? '';

    const resultContent = extractText(msg);
    const hasBody = !!(resultContent || isBash) && !isRead;

    const footer = buildToolFooter(msg, ctx.allMessages, ctx.msgIndex);

    const wrapper = el('div', 'tool-card-wrapper');

    if (hasBody) {
        const details = document.createElement('details');
        details.className = 'tool-card tool-expandable';

        details.innerHTML = `
            <summary class="tool-header">
                ${buildToolCardHeaderHtml(toolName, label, buildStatusHtml(isError ? 'error' : 'done'))}
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

        applyMemoryBadge(details, toolCallId, ctx.approvalTraces);
        if (footer) wrapper.appendChild(footer);
        return wrapper;
    }

    const card = el('div', `tool-card${isRead ? ' tool-clickable' : ''}`);
    if (isRead && filePath) card.dataset.filepath = filePath;
    card.appendChild(buildToolCardHeader(toolName, label, buildStatusHtml(isError ? 'error' : 'done')));

    wrapper.appendChild(card);
    applyMemoryBadge(card, toolCallId, ctx.approvalTraces);
    if (footer) wrapper.appendChild(footer);
    return wrapper;
}

// ── Approval cards ──

export function buildToolApprovalCard(pending: ToolCallPendingInfo): HTMLElement {
    const parsedArgs = typeof pending.args === 'string' ? tryParseJSON(pending.args) : pending.args;
    const label = getToolLabel(pending.toolName, parsedArgs);

    const card = el('div', 'tool-approval-card');
    card.id = `approval-${pending.toolCallId}`;

    card.appendChild(buildToolCardHeader(pending.toolName, label, `<span class="tool-status pending">${escHtml(t('approval.awaiting'))}</span>`));

    const args = el('div', 'approval-args');
    args.textContent = formatToolArgs(parsedArgs);
    card.appendChild(args);

    const actions = el('div', 'approval-actions');
    actions.innerHTML = `
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
    `;
    card.appendChild(actions);

    return card;
}

// ── Apply preview cards (code block → file) ──

export function buildApplyPreviewCard(preview: ApplyPreviewInfo): HTMLElement {
    const fileName = preview.targetPath.split(/[\\/]/).pop() ?? preview.targetPath;
    const dirPath = preview.targetPath.split(/[\\/]/).slice(0, -1).join('/');

    const statsHtml = diffStatsHtml(preview.addedLines, preview.removedLines);

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
    return card;
}

// ── Changed files section ──

export function buildChangedFilesSection(fileChanges: FileChangeInfo[], rollbackPoint: number | null): HTMLElement {
    const details = document.createElement('details');
    details.className = 'changed-files-section';
    details.id = 'changed-files-bar';

    const fileMap = new Map<string, FileChangeInfo>();
    for (const c of fileChanges) {
        fileMap.set(c.filePath, c);
    }
    const uniqueFiles = [...fileMap.values()];
    const count = uniqueFiles.length;

    const summary = document.createElement('summary');
    summary.className = 'changed-files-summary';
    const undoRedoBtn = rollbackPoint !== null
        ? `<button class="changed-files-link" id="btn-redo" title="${escHtml(t('files.redoTitle'))}">${escHtml(t('files.redo'))}</button>`
        : `<button class="changed-files-link" id="btn-undo" title="${escHtml(t('files.undoTitle'))}">${escHtml(t('files.undo'))}</button>`;
    summary.innerHTML = `
        <span class="changed-files-arrow">&#9656;</span>
        <span class="changed-files-count">${escHtml(t(count === 1 ? 'files.countOne' : 'files.countMany', { n: count }))}</span>
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

// ── Config banner ──

export function buildConfigBanner(config: PiConfigSnapshot | undefined): HTMLElement | null {
    if (!config) return null;

    const banner = el('div', 'config-banner');
    if (config.status === 'not-found') {
        const msg = el('div', 'config-issue');
        msg.textContent = t('config.notFound', { dir: config.agentDir });
        banner.appendChild(msg);
    } else {
        const stats = el('div', 'config-stats');
        stats.textContent = t('config.stats', {
            providers: t(config.providers.length === 1 ? 'config.providerCountOne' : 'config.providerCountMany', { n: config.providers.length }),
            models: t(config.models.length === 1 ? 'config.modelCountOne' : 'config.modelCountMany', { n: config.models.length }),
            skills: t(config.skills.length === 1 ? 'config.skillCountOne' : 'config.skillCountMany', { n: config.skills.length }),
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
    banner.appendChild(refresh);
    return banner;
}
