// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildTranscriptClipboardHtml, isPortableLinkTarget } from '../../../webview/transcript-clipboard';

function mount(html: string): HTMLElement {
    const root = document.createElement('div');
    root.id = 'messages';
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
}

function selectAllOf(root: HTMLElement, selector: string): Selection {
    const target = root.querySelector(selector)!;
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
}

describe('isPortableLinkTarget', () => {
    it('keeps only web links', () => {
        expect(isPortableLinkTarget('https://example.com')).toBe(true);
        expect(isPortableLinkTarget('http://example.com/x')).toBe(true);
        expect(isPortableLinkTarget('vscode-webview://host/x.html')).toBe(false);
        expect(isPortableLinkTarget('command:pi.open')).toBe(false);
        expect(isPortableLinkTarget('file:///etc/passwd')).toBe(false);
    });
});

describe('buildTranscriptClipboardHtml', () => {
    it('strips hover toolbars from the copied fragment', () => {
        const root = mount(`
            <div class="message-content"><p>intro</p>
                <div class="code-block-wrapper">
                    <div class="code-block-header" data-no-copy="1"><span class="code-lang">python</span>
                        <span class="code-block-actions" role="toolbar"><button class="copy-btn">Copy</button></span>
                    </div>
                    <pre><code>print(1)</code></pre>
                </div>
            </div>`);
        const selection = selectAllOf(root, '.message-content');
        const html = buildTranscriptClipboardHtml(selection, root)!;
        expect(html).toContain('print(1)');
        expect(html).not.toContain('code-block-actions');
        expect(html).not.toContain('>Copy<');
        root.remove();
    });

    it('reduces webview-only links to their visible label', () => {
        const root = mount(`
            <div class="message-content"><p>see <a data-href="vscode-webview://xyz/page.html" href="#">docs page</a> for more</p></div>`);
        const selection = selectAllOf(root, 'p');
        const html = buildTranscriptClipboardHtml(selection, root)!;
        expect(html).not.toContain('vscode-webview');
        expect(html).not.toContain('<a');
        expect(html).toContain('<code>docs page</code>');
        root.remove();
    });

    it('keeps portable links as anchors', () => {
        const root = mount(`
            <div class="message-content"><p>see <a href="https://example.com/a">the docs</a></p></div>`);
        const selection = selectAllOf(root, 'p');
        const html = buildTranscriptClipboardHtml(selection, root)!;
        expect(html).toContain('<a href="https://example.com/a">the docs</a>');
        root.remove();
    });

    it('preserves the heading structure around the selection', () => {
        const root = mount(`
            <div class="message-content"><h2>Results</h2></div>`);
        const selection = selectAllOf(root, '.message-content');
        const html = buildTranscriptClipboardHtml(selection, root)!;
        expect(html).toContain('<h2>Results</h2>');
        root.remove();
    });

    it('drops hidden elements from the fragment', () => {
        const root = mount(`
            <div class="message-content"><p>visible <span hidden>secret</span> tail</p></div>`);
        const selection = selectAllOf(root, 'p');
        const html = buildTranscriptClipboardHtml(selection, root)!;
        expect(html).toContain('visible');
        expect(html).not.toContain('secret');
        root.remove();
    });

    it('returns null for selections outside the transcript root', () => {
        const root = mount(`<div class="message-content"><p>text</p></div>`);
        const outside = document.createElement('p');
        outside.textContent = 'elsewhere';
        document.body.appendChild(outside);
        const range = document.createRange();
        range.selectNodeContents(outside);
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        expect(buildTranscriptClipboardHtml(selection, root)).toBeNull();
        root.remove();
        outside.remove();
    });
});
