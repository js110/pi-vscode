/**
 * Clean clipboard flavors for transcript selections — a port of VS Code
 * Copilot Chat's chatClipboard.ts (cloneVisibleSelection + sanitization).
 *
 * A raw browser copy of a chat transcript is dirty in two ways: the hover
 * toolbars riding inside the selection land in the clipboard as stray
 * "Copy / Apply" text, and the text/html flavor carries vscode-webview://
 * link targets that only resolve inside this webview. Before the copy
 * reaches the OS we clone the selected range, drop everything the reader
 * cannot see (toolbars, collapsed/hidden blocks), keep the surrounding
 * structure (headings, list items, whole links) so the paste keeps its
 * shape, and reduce unportable links to the label text the reader saw.
 *
 * Pure DOM helpers only; happy-dom testable.
 */

const HIDDEN_MARK = 'data-pi-clipboard-hidden';

/** Controls rendered alongside chat content whose markup says nothing about
 *  what the reader selected: code-block action rows, hover copy buttons. */
const CONTROL_SELECTOR = '[role="toolbar"], [data-no-copy]';

/** Link/image targets that survive outside this webview. */
export function isPortableLinkTarget(target: string): boolean {
    return /^https?:\/\//i.test(target);
}

/**
 * Clones a selected range of rendered chat content along with the elements
 * it sits inside, up to `root`. `Range.cloneContents()` returns only what
 * lies between the boundaries, which drops the heading or list item giving
 * the text its shape and, for a partly selected link, the rest of its
 * label — so ancestors are re-wrapped around the fragment. Elements the
 * reader cannot see and toolbars are removed.
 */
export function cloneVisibleSelection(range: Range, root: Node): DocumentFragment {
    const hiddenElements = findHiddenElements(range);
    for (const element of hiddenElements) {
        element.setAttribute(HIDDEN_MARK, '');
    }

    try {
        const fragment = cloneWithAncestors(range, root);
        // eslint-disable-next-line no-restricted-syntax -- detached fragment
        for (const element of Array.from(fragment.querySelectorAll(`[${HIDDEN_MARK}], ${CONTROL_SELECTOR}`))) {
            element.remove();
        }
        return fragment;
    } finally {
        for (const element of hiddenElements) {
            element.removeAttribute(HIDDEN_MARK);
        }
    }
}

/** Finds the outermost elements in `range` the reader cannot see: elements
 *  with no box (display:none) or fully transparent ones a collapsed section
 *  hides while keeping them laid out. */
function findHiddenElements(range: Range): Element[] {
    const scope = range.commonAncestorContainer;
    const ownerDocument = scope.ownerDocument;
    if (!ownerDocument) return [];
    const hiddenElements: Element[] = [];
    const isVisible = (element: Element): boolean => {
        // The `hidden` attribute first: happy-dom's checkVisibility is a stub,
        // and in real browsers the attribute implies display:none anyway.
        if (element.hasAttribute('hidden')) return false;
        const html = element as HTMLElement;
        if (typeof html.checkVisibility === 'function') {
            return html.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true } as CheckVisibilityOptions);
        }
        return true;
    };
    const walker = ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node) => {
            if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
            const element = node as Element;
            if (isVisible(element)) return NodeFilter.FILTER_ACCEPT;
            hiddenElements.push(element);
            return NodeFilter.FILTER_REJECT;
        },
    });
    while (walker.nextNode()) {
        // The filter collects the hidden elements.
    }
    return hiddenElements;
}

function cloneWithAncestors(range: Range, root: Node): DocumentFragment {
    let content: Node = range.cloneContents();

    for (
        let ancestor = range.commonAncestorContainer;
        ancestor && ancestor !== root;
        ancestor = ancestor.parentNode as Node
    ) {
        if ((ancestor as Element).nodeType !== 1) continue;

        // A link is one unit: selecting part of "foo.ts:42" should still copy
        // the whole reference rather than a fragment of its label.
        if ((ancestor as Element).tagName === 'A') {
            content = ancestor.cloneNode(true);
            continue;
        }

        const wrapper = ancestor.cloneNode(false);
        wrapper.appendChild(content);
        content = wrapper;
    }

    if (content.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        return content as DocumentFragment;
    }

    const fragment = (range.commonAncestorContainer.ownerDocument ?? document).createDocumentFragment();
    fragment.appendChild(content);
    return fragment;
}

/** Replaces an element with the text a reader saw, marked up as code. */
function replaceWithLabel(element: Element): void {
    const label = element.textContent ?? '';
    if (!label.trim()) {
        element.remove();
        return;
    }
    const code = element.ownerDocument?.createElement('code');
    if (!code) {
        element.remove();
        return;
    }
    code.textContent = label;
    element.replaceWith(code);
}

/**
 * Rewrites a copied transcript selection so it stays useful outside this
 * webview: links and images whose targets only resolve here are reduced to
 * the text the reader saw. Returns whether anything changed.
 */
export function sanitizeTranscriptClipboardFragment(fragment: DocumentFragment): boolean {
    let changed = false;

    // eslint-disable-next-line no-restricted-syntax -- detached fragment
    for (const anchor of Array.from(fragment.querySelectorAll('a'))) {
        const target = (anchor.getAttribute('data-href') || anchor.getAttribute('href') || '').trim();
        if (isPortableLinkTarget(target)) {
            anchor.setAttribute('href', target);
            anchor.removeAttribute('data-href');
            continue;
        }
        replaceWithLabel(anchor);
        changed = true;
    }

    // eslint-disable-next-line no-restricted-syntax -- detached fragment
    for (const image of Array.from(fragment.querySelectorAll('img'))) {
        if (!isPortableLinkTarget(image.getAttribute('src') ?? '')) {
            replaceWithLabel(image);
            changed = true;
        }
    }

    // eslint-disable-next-line no-restricted-syntax -- detached fragment
    for (const element of Array.from(fragment.querySelectorAll('[data-href]'))) {
        element.removeAttribute('data-href');
    }

    return changed;
}

/** The HTML for a cleaned transcript selection, or null when `selection`
 *  holds nothing copyable inside `root`. */
export function buildTranscriptClipboardHtml(selection: Selection, root: Node): string | null {
    if (selection.isCollapsed || selection.rangeCount === 0) return null;
    const ranges: Range[] = [];
    for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if (!root.contains(range.commonAncestorContainer)) continue;
        ranges.push(range);
    }
    if (!ranges.length) return null;

    const holder = (root.ownerDocument ?? document).createElement('div');
    for (const range of ranges) {
        const fragment = cloneVisibleSelection(range, root);
        sanitizeTranscriptClipboardFragment(fragment);
        holder.appendChild(fragment);
    }
    return holder.innerHTML;
}
