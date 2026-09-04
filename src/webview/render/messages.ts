// Deep module for building static message/render DOM nodes.
//
// These functions are pure: given inputs (plus the shared DOM helpers), they
// return detached HTMLElement nodes. They hold no module state, touch no
// `vscode` API, and render no side effects on the document, which makes them
// directly unit-testable with happy-dom.
import { marked } from 'marked';
import type { FileChangeInfo } from '../../shared/protocol';
import {
    escAttr,
    formatTimestamp,
    tryParseJSON,
    extractToolResultText,
    buildStatusHtml,
    getToolIcon,
    getToolLabel,
    renderDiffLines,
} from '../../shared/webview-text';
import { el, escHtml } from '../dom';

// ── Markdown rendering ──

let codeBlockId = 0;
const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }: { text: string; lang?: string | undefined }) {
    const id = `cb-${++codeBlockId}`;
    const langLabel = lang ? `<span class="code-lang">${escHtml(lang)}</span>` : '';
    return `<div class="code-block-wrapper">
        <div class="code-block-header">${langLabel}<button class="copy-btn" data-code-id="${id}">Copy</button></div>
        <pre class="code-block-pre" id="${id}"><code class="code-block-code">${escHtml(text)}</code></pre>
    </div>`;
};

renderer.codespan = function ({ text }: { text: string }) {
    return `<code>${text}</code>`;
};

marked.setOptions({
    renderer,
    breaks: true,
    gfm: true,
});

export function renderMarkdown(text: string): string {
    if (!text) return '';
    return marked.parse(text) as string;
}

export function resetCodeBlockIds(): void {
    codeBlockId = 0;
}

// ── Static view builders ──

export function buildWelcome(): HTMLElement {
    const w = el('div', 'welcome');
    w.innerHTML = `
        <div class="welcome-icon">&pi;</div>
        <div class="welcome-title">Pi Agent</div>
        <div class="welcome-subtitle">Pi reads, writes, and runs code in this workspace. Tell it what to build and it will show its work as it goes.</div>
        <div class="welcome-hints">
            <div class="welcome-hint">Type <kbd>/</kbd> for commands and skills</div>
        </div>
    `;
    return w;
}

export function buildThinkingBlock(text: string, active: boolean, durationSec?: number): HTMLElement {
    const details = document.createElement('details');
    details.className = `thinking-block${active ? ' active' : ''}`;
    let label: string;
    if (active) {
        label = 'Thinking...';
    } else if (durationSec && durationSec > 0) {
        label = `Thought for ${durationSec} second${durationSec !== 1 ? 's' : ''}`;
    } else {
        label = 'Thought';
    }
    details.innerHTML = `
        <summary class="thinking-summary">
            <span class="thinking-indicator"></span>
            <span class="thinking-label">${label}</span>
            <span class="thinking-chevron">&#9656;</span>
        </summary>
        <div class="thinking-content">${renderMarkdown(text)}</div>
    `;
    return details;
}

export function buildDiffCard(change: FileChangeInfo, msg?: any): HTMLElement {
    const wrapper = el('div', 'tool-card-wrapper');

    const card = el('div', 'diff-card');
    card.id = `diff-${change.toolCallId}`;

    const fileName = change.filePath.split('/').pop() ?? change.filePath;
    const dirPath = change.filePath.split('/').slice(0, -1).join('/');

    let statsHtml = '';
    if (change.addedLines > 0 || change.removedLines > 0) {
        statsHtml = `<span class="diff-stats">`;
        if (change.addedLines > 0) statsHtml += `<span class="diff-stat-add">+${change.addedLines}</span>`;
        if (change.removedLines > 0) statsHtml += `<span class="diff-stat-del">-${change.removedLines}</span>`;
        statsHtml += `</span>`;
    }

    card.innerHTML = `
        <div class="diff-file-header" data-filepath="${escAttr(change.filePath)}" data-toolcallid="${escAttr(change.toolCallId)}">
            <span class="diff-file-icon">${change.isNew ? '&#10010;' : '&#9998;'}</span>
            <span class="diff-file-name">${escHtml(fileName)}</span>
            ${dirPath ? `<span class="diff-file-dir">${escHtml(dirPath)}</span>` : ''}
            ${statsHtml}
            ${change.isNew ? '<span class="diff-new-badge">NEW</span>' : ''}
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

export function buildToolCard(tc: any): HTMLElement {
    const card = el('div', 'tool-card');
    const name = tc.name ?? tc.toolName ?? tc.function?.name ?? 'unknown';
    const args = tc.args ?? tc.arguments ?? tc.input ?? tc.function?.arguments;
    const parsedArgs = typeof args === 'string' ? tryParseJSON(args) : args;
    const statusClass = tc._status ?? 'pending';

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(name)}</span>
            <span class="tool-name">${escHtml(getToolLabel(name, parsedArgs))}</span>
            ${buildStatusHtml(statusClass)}
        </div>
    `;

    if (tc._result !== undefined) {
        const text = extractToolResultText(tc._result);
        if (text) {
            const result = el('pre', 'tool-result');
            result.textContent = text;
            card.appendChild(result);
        }
    }

    return card;
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
