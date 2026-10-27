// Markdown engine parity tests: features ported from VS Code Copilot Chat's
// rendering pipeline (see docs/research/copilot-chat-content-rendering.md):
// - literal single tildes (microsoft/vscode#323199)
// - ```diff / ```diff:<lang> line-tinted code blocks
// - allowlisted markdown images with a text fallback
// - horizontally scrollable GFM tables
// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderMarkdown, prepareMarkdown } from '../../../webview/render/messages';

beforeAll(async () => {
    await prepareMarkdown();
});

describe('literal single tilde (VS Code chat parity)', () => {
    it('keeps single ~ as literal text', () => {
        const html = renderMarkdown('edit ~/config and ~x~ stays');
        expect(html).not.toContain('<del>');
        expect(html).toContain('~/config');
        expect(html).toContain('~x~');
    });

    it('still renders double-tilde strikethrough', () => {
        const html = renderMarkdown('gone ~~home~~ now');
        expect(html).toContain('<del>home</del>');
    });
});

describe('diff code blocks', () => {
    const UNIFIED = [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1234567..89abcde 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,3 +1,3 @@',
        ' context line',
        '-removed line',
        '+added line',
    ].join('\n');

    it('tints add/del/hunk/meta lines', () => {
        const html = renderMarkdown('```diff\n' + UNIFIED + '\n```');
        expect(html).toContain('diff-pre');
        expect(html).toContain('diff-meta');
        expect(html).toContain('diff-hunk');
        expect(html).toContain('diff-add');
        expect(html).toContain('diff-del');
        // Context rows are plain diff-line rows.
        expect(html).toContain('context line');
        // Prefixes stay visible, GitHub-style.
        expect(html).toContain('+added line');
        expect(html).toContain('-removed line');
    });

    it('shows the lang label for diff:<lang> and still tints rows', () => {
        const html = renderMarkdown('```diff:ts\n+const x = 1;\n```');
        expect(html).toContain('diff-pre');
        expect(html).toContain('diff-add');
        expect(html).toContain('+const x = 1;');
        // The Copilot-style inner language is surfaced as the block label.
        expect(html).toContain('diff:ts');
    });

    it('keeps copy but drops apply on diff blocks', () => {
        const html = renderMarkdown('```diff\n+hello\n```');
        expect(html).toContain('copy-btn');
        expect(html).not.toContain('apply-btn');
    });

    it('treats patch the same as diff', () => {
        const html = renderMarkdown('```patch\n+hello\n```');
        expect(html).toContain('diff-pre');
        expect(html).toContain('diff-add');
    });
});

describe('markdown images', () => {
    it('renders https images lazily', () => {
        const html = renderMarkdown('![logo](https://example.com/logo.png)');
        expect(html).toContain('<img');
        expect(html).toContain('md-img');
        expect(html).toContain('loading="lazy"');
        expect(html).toContain('alt="logo"');
    });

    it('renders base64 data-image URIs', () => {
        const html = renderMarkdown('![dot](data:image/png;base64,iVBORw0KGgo=)');
        expect(html).toContain('<img');
        expect(html).toContain('md-img');
    });

    it('degrades http images to a text chip', () => {
        const html = renderMarkdown('![insecure](http://example.com/x.png)');
        expect(html).not.toContain('<img');
        expect(html).toContain('md-img-fallback');
        expect(html).toContain('insecure');
    });

    it('degrades non-image and script URIs to a text chip', () => {
        const js = renderMarkdown('![x](javascript:alert(1))');
        expect(js).not.toContain('<img');
        expect(js).toContain('md-img-fallback');
        const data = renderMarkdown('![x](data:text/html;base64,PGI=)');
        expect(data).not.toContain('<img');
    });
});

describe('table scrolling wrapper', () => {
    it('wraps GFM tables in .table-scroll', () => {
        const html = renderMarkdown('| a | b |\n| --- | ---: |\n| 1 | 2 |');
        expect(html).toContain('table-scroll');
        expect(html).toContain('<th>a</th>');
        expect(html).toContain('<td>1</td>');
        // Column alignment from the delimiter row survives.
        expect(html).toContain('text-align:right');
        // The wrapper must be outside the table, not inside a cell.
        expect(html.indexOf('table-scroll')).toBeLessThan(html.indexOf('<table'));
    });
});

describe('katex math (VS Code chat parity)', () => {
    it('renders inline $…$ math', () => {
        const html = renderMarkdown('mass equals $E=mc^2$ exactly');
        expect(html).toContain('katex-container');
        expect(html).toContain('class="katex"');
        // LaTeX source is preserved as a copy-friendly fallback.
        expect(html).toContain('data-latex="E=mc^2"');
    });

    it('renders $$…$$ as display math inline', () => {
        const html = renderMarkdown('before $$\\int_0^1 x\\,dx$$ after');
        expect(html).toContain('katex-display');
    });

    it('renders $$-newline blocks as display math', () => {
        const html = renderMarkdown('$$\n\\frac{a}{b}\n$$');
        expect(html).toContain('katex-display');
        expect(html).toContain('data-latex="\\frac{a}{b}"');
    });

    it('does not treat prose dollars as math', () => {
        const html = renderMarkdown('I have $5 and $10 in my 10$ wallet');
        expect(html).not.toContain('katex');
    });

    it('does not fire when a dollar is followed by dot/quote or closed against a word', () => {
        // Opening $ followed by '.', '(' + quote never starts math (VS Code regex).
        expect(renderMarkdown('spend $.50 now')).not.toContain('katex');
        expect(renderMarkdown('fn $("x") call')).not.toContain('katex');
        // Closing $ followed by a word character never ends math.
        expect(renderMarkdown('rate is $x$y per unit')).not.toContain('katex');
    });

    it('falls back to the raw text on invalid LaTeX', () => {
        const html = renderMarkdown('bad $\\frac{1{$ math');
        expect(html).not.toContain('katex-container');
        expect(html).toContain('\\frac{1{');
    });
});
