// Markdown + syntax-highlighting engine.
//
// This module is the webview's lazy chunk: it is the only place that imports
// `marked` and `highlight.js`, so bundling it behind the dynamic import in
// messages.ts keeps both heavy libraries out of the entry bundle. The webview
// boots (shell, tabs, input, welcome) and compiles this chunk in parallel;
// renderers call it once it has resolved.
import { marked, type Token, type Tokens, type TokenizerAndRendererExtension } from 'marked';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import { escHtml } from '../dom';
import { escAttr } from '../../shared/webview-text';
import { t } from '../../shared/i18n';

let codeBlockId = 0;
const renderer = new marked.Renderer();

const NON_APPLY_LANGS = new Set(['text', 'plaintext', 'plain', 'txt', '', 'diff', 'patch']);

// ── Diff code blocks (```diff / ```diff:<lang> / ```patch) ──
// VS Code parity: Copilot renders ```` ```diff:ts ```` streams through a real
// Monaco diff editor (MarkdownDiffBlockPart). In the webview we approximate
// the visual with line-level added/deleted/hunk/meta rows using VS Code's
// diffEditor color tokens. The +/- prefixes are kept, GitHub-style.
const DIFF_LANGS = new Set(['diff', 'patch', 'udiff']);
const DIFF_META_RE = /^(diff --git |index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch|\*\*\* )/;

function diffLineClass(line: string): string {
    if (line.startsWith('@@')) return 'diff-hunk';
    if (line.startsWith('+++')) return 'diff-meta';
    if (line.startsWith('---')) return 'diff-meta';
    if (line.startsWith('+')) return 'diff-add';
    if (line.startsWith('-')) return 'diff-del';
    if (DIFF_META_RE.test(line)) return 'diff-meta';
    return '';
}

function renderDiffBody(text: string): string {
    return text
        .replace(/\n$/, '')
        .split('\n')
        .map((line) => {
            const cls = diffLineClass(line);
            // Empty rows get an nbsp so the block-level row keeps its height.
            return `<span class="diff-line${cls ? ` ${cls}` : ''}">${line ? escHtml(line) : '&nbsp;'}</span>`;
        })
        .join('');
}

// ── Markdown images ──
// VS Code parity: chat only allows remote images from a trusted allowlist and
// forces max-width:100%. We accept https plus inline data:image URIs (SVG
// scripts never execute inside <img>) and degrade everything else to a text
// chip instead of emitting an <img> tag.
const DATA_IMAGE_RE = /^data:image\/(?:png|gif|jpeg|jpg|webp|avif|bmp|svg\+xml);base64,[a-z0-9+/=]+$/i;

function isAllowedImageSrc(href: string): boolean {
    return /^https:\/\//i.test(href) || DATA_IMAGE_RE.test(href);
}

renderer.code = function ({ text, lang }: { text: string; lang?: string | undefined }) {
    const id = `cb-${++codeBlockId}`;
    const normalizedLang = (lang ?? '').trim().toLowerCase();
    const baseLang = normalizedLang.split(':')[0] ?? '';
    const lineCount = text.split('\n').length;
    const collapsible = lineCount > 20;
    let body: string;
    if (DIFF_LANGS.has(baseLang)) {
        body = renderDiffBody(text);
    } else if (normalizedLang && hljs.getLanguage(normalizedLang)) {
        body = hljs.highlight(text, { language: normalizedLang }).value;
    } else {
        body = escHtml(text);
    }
    const langLabel = lang ?? '';
    // diff/patch blocks are not applyable; a "diff:<lang>" label bypasses the
    // plain-lang set, so key off the base language as well.
    const applyable = !DIFF_LANGS.has(baseLang) && !NON_APPLY_LANGS.has(normalizedLang);
    const applyBtn = applyable
        ? `<button class="apply-btn" data-apply-id="${id}" data-apply-lang="${escAttr(normalizedLang)}">${escHtml(t('code.apply'))}</button>`
        : '';
    return `<div class="code-block-wrapper${collapsible ? ' code-block-collapsed' : ''}">
        <div class="code-block-header">${langLabel ? `<span class="code-lang">${escHtml(langLabel)}</span>` : ''}<span class="code-block-actions">${applyBtn}<button class="copy-btn" data-code-id="${id}">${escHtml(t('code.copy'))}</button></span></div>
        <pre class="code-block-pre${DIFF_LANGS.has(baseLang) ? ' diff-pre' : ''}" id="${id}"><code class="code-block-code hljs">${body}</code></pre>
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

renderer.image = function ({ href, title, text }: { href: string; title?: string | null; text: string }) {
    if (!href || !isAllowedImageSrc(href)) {
        // Not trusted/valid: degrade to an inline chip rather than emitting an img.
        return `<span class="md-img-fallback" title="${escAttr(href ?? '')}">${escHtml(text || href || 'image')}</span>`;
    }
    return `<img class="md-img" src="${escAttr(href)}" alt="${escAttr(text ?? '')}"${title ? ` title="${escAttr(title)}"` : ''} loading="lazy" />`;
};

// Wrap GFM tables in a horizontally scrollable container so wide tables stop
// stretching the chat bubble (VS Code's chatMarkdownTableScrolling).
renderer.table = function (this: any, token: { header: any[]; rows: any[][] }) {
    const cell = (c: any, tag: 'th' | 'td'): string => {
        const align = c.align ? ` style="text-align:${escAttr(c.align)}"` : '';
        const inner = this.parser?.parseInline(c.tokens) ?? escHtml(c.text ?? '');
        return `<${tag}${align}>${inner}</${tag}>`;
    };
    const thead = `<tr>${token.header.map((c: any) => cell(c, 'th')).join('')}</tr>`;
    const tbody = token.rows.map((row: any[]) => `<tr>${row.map((c: any) => cell(c, 'td')).join('')}</tr>`).join('');
    return `<div class="table-scroll"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
};

// ── Math (KaTeX) ──
// Ported from VS Code's chat math rendering
// (workbench/contrib/markdown/common/markedKatexExtension.ts, itself from
// UziTech/marked-katex-extension): $…$ / $$…$$ inline and $$\n…\n$$ blocks.
// The lookarounds keep prose like "I have $5 and $10" from becoming math.
// Stylesheet + fonts are copied next to the webview bundle by esbuild.js
// (see sidebar.ts <link> katex.min.css).
const mathInlineRegExp = /(?<![a-zA-Z0-9])(?<dollars>\${1,2})(?!\.|\(["\'])((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\k<dollars>(?![a-zA-Z0-9])/;
// Kept as a literal so the escaping stays reviewable; the tokenizer rule is
// the same pattern anchored to the start of marked's inline token source.
const inlineMathRule = new RegExp('^' + mathInlineRegExp.source);
const blockMathRule = /^(\${1,2})\n((?:\\[^]|[^\\])+?)\n\1(?:\n|$)/;
const blockMathStartRule = new RegExp(blockMathRule.source, 'm');

function renderKatex(text: string, displayMode: boolean, raw: string, isBlock: boolean): string {
    try {
        const html = katex.renderToString(text, { throwOnError: true, displayMode });
        // Keep the LaTeX source in a data attribute as a copy-friendly fallback.
        return `<span class="katex-container" data-latex="${escAttr(text)}">${html}</span>` + (isBlock ? '\n' : '');
    } catch {
        // On invalid LaTeX show the original text, not a red parse error.
        return raw;
    }
}

const katexTokenizers: TokenizerAndRendererExtension[] = [
    {
        name: 'inlineKatex',
        level: 'inline',
        start(src: string) {
            let index: number;
            let indexSrc = src;
            while (indexSrc) {
                index = indexSrc.indexOf('$');
                if (index === -1) return undefined;
                const possible = indexSrc.substring(index);
                if (possible.match(inlineMathRule)) return index;
                indexSrc = indexSrc.substring(index + 1).replace(/^\$+/, '');
            }
            return undefined;
        },
        tokenizer(src: string) {
            const match = src.match(inlineMathRule);
            if (match) {
                return {
                    type: 'inlineKatex',
                    raw: match[0],
                    text: match[2].trim(),
                    displayMode: match[1].length === 2,
                } as Token;
            }
            return undefined;
        },
        renderer: (token: Tokens.Generic) =>
            renderKatex(token.text, token.displayMode === true, token.raw, false),
    },
    {
        name: 'blockKatex',
        level: 'block',
        start(src: string) {
            return src.match(blockMathStartRule)?.index;
        },
        tokenizer(src: string) {
            const match = src.match(blockMathRule);
            if (match) {
                return {
                    type: 'blockKatex',
                    raw: match[0],
                    text: match[2].trim(),
                    displayMode: match[1].length === 2,
                } as Token;
            }
            return undefined;
        },
        renderer: (token: Tokens.Generic) =>
            renderKatex(token.text, token.displayMode === true, token.raw, true),
    },
];

// Single tildes are literal text; only double ~~ triggers strikethrough.
// Copilot had the same fix (microsoft/vscode#323199) so paths like ~/files and
// `~x~` don't get eaten as <del>.
const literalSingleTildeTokenizer: TokenizerAndRendererExtension = {
    name: 'literalSingleTilde',
    level: 'inline',
    start(src: string) { return src.indexOf('~'); },
    tokenizer(src: string) {
        if (src.charAt(0) === '~' && src.charAt(1) !== '~') {
            return { type: 'text', raw: '~', text: '~' };
        }
        return undefined;
    },
};

marked.use({
    renderer,
    breaks: true,
    gfm: true,
    extensions: [literalSingleTildeTokenizer, ...katexTokenizers],
});

export function renderMarkdownWithEngine(text: string): string {
    if (!text) return '';
    return marked.parse(text) as string;
}

export function resetEngineCodeBlockIds(): void {
    codeBlockId = 0;
}