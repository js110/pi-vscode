// Markdown + syntax-highlighting engine.
//
// This module is the webview's lazy chunk: it is the only place that imports
// `marked` and `highlight.js`, so bundling it behind the dynamic import in
// messages.ts keeps both heavy libraries out of the entry bundle. The webview
// boots (shell, tabs, input, welcome) and compiles this chunk in parallel;
// renderers call it once it has resolved.
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import { escHtml } from '../dom';
import { escAttr } from '../../shared/webview-text';
import { t } from '../../shared/i18n';

let codeBlockId = 0;
const renderer = new marked.Renderer();

const NON_APPLY_LANGS = new Set(['text', 'plaintext', 'plain', 'txt', '']);

renderer.code = function ({ text, lang }: { text: string; lang?: string | undefined }) {
    const id = `cb-${++codeBlockId}`;
    const normalizedLang = (lang ?? '').trim().toLowerCase();
    let highlighted: string;
    let langLabel = lang ?? '';
    if (normalizedLang && hljs.getLanguage(normalizedLang)) {
        highlighted = hljs.highlight(text, { language: normalizedLang }).value;
    } else {
        highlighted = escHtml(text);
    }
    const lineCount = text.split('\n').length;
    const collapsible = lineCount > 20;
    const applyable = !NON_APPLY_LANGS.has(normalizedLang);
    const applyBtn = applyable
        ? `<button class="apply-btn" data-apply-id="${id}" data-apply-lang="${escAttr(normalizedLang)}">${escHtml(t('code.apply'))}</button>`
        : '';
    return `<div class="code-block-wrapper${collapsible ? ' code-block-collapsed' : ''}">
        <div class="code-block-header">${langLabel ? `<span class="code-lang">${escHtml(langLabel)}</span>` : ''}<span class="code-block-actions">${applyBtn}<button class="copy-btn" data-code-id="${id}">${escHtml(t('code.copy'))}</button></span></div>
        <pre class="code-block-pre" id="${id}"><code class="code-block-code hljs">${highlighted}</code></pre>
        ${collapsible ? `<button class="code-block-toggle" data-toggle-id="${id}">${escHtml(t('code.showMore'))}</button>` : ''}
    </div>`;
};

renderer.codespan = function ({ text }: { text: string }) {
    return `<code>${escHtml(text)}</code>`;
};

renderer.html = function ({ text }: { text: string }) {
    return escHtml(text);
};

renderer.link = function (this: any, { href, title, tokens }: { href: string; title?: string | null; tokens: unknown[] }) {
    const text = this.parser?.parseInline(tokens) ?? '';
    if (/^javascript:/i.test(href)) return text;
    return `<a href="${escAttr(href)}"${title ? ` title="${escAttr(title)}"` : ''}>${text}</a>`;
};

marked.setOptions({
    renderer,
    breaks: true,
    gfm: true,
});

export function renderMarkdownWithEngine(text: string): string {
    if (!text) return '';
    return marked.parse(text) as string;
}

export function resetEngineCodeBlockIds(): void {
    codeBlockId = 0;
}