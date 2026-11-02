/**
 * Lifecycle of the transcript selection mark: a synchronous snapshot of the
 * last non-empty selection inside the chat transcript's message content.
 *
 * The mark exists because focusing the composer (which VS Code does after
 * intercepting Cmd/Ctrl+C in a webview view) collapses the document
 * selection, so any deferred read comes back empty. The copy defense and the
 * debounced quote capture read this snapshot instead of the live selection.
 *
 * Abandonment rules:
 *  - a new left-click anywhere in the document starts a new gesture (a
 *    right-click keeps the mark so the context menu can still copy it),
 *  - window blur — focus left the webview entirely — drops it, so a mark
 *    made in the transcript can never hijack a later Cmd/Ctrl+C and copy
 *    stale transcript text instead of what the user last selected
 *    elsewhere. Inner focus restoration does not blur the window, so the
 *    legitimate fallback (mark stands in for the collapsed selection)
 *    survives,
 *  - explicit clears (tab switch, consumed quote).
 *
 * Pure DOM helpers only; happy-dom testable.
 */

let lastLiveTranscriptSelection: string | null = null;

function nodeInsideMessageContent(node: Node | null): boolean {
    if (!node) return false;
    const element = node.nodeType === 3 ? node.parentElement : (node as Element);
    return !!element?.closest?.('.message-content');
}

/** The text currently marked inside the transcript (message content only),
 *  or null when nothing usable is selected. Shared by the quote capture and
 *  the copy paths. */
export function transcriptSelectionText(): string | null {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    if (!nodeInsideMessageContent(selection.anchorNode) || !nodeInsideMessageContent(selection.focusNode)) return null;
    const text = selection.toString().replace(/\u00a0/g, ' ').trim();
    return text || null;
}

/** Snapshot the live selection (selectionchange handler): call this
 *  synchronously, before any focus change can collapse the selection. */
export function rememberLiveTranscriptSelection(): void {
    const text = transcriptSelectionText();
    if (text) lastLiveTranscriptSelection = text;
}

/** The text a copy action should use: the live transcript selection, or the
 *  last live one once focus restoration has collapsed the selection. */
export function copyTargetText(): string | null {
    return transcriptSelectionText() ?? lastLiveTranscriptSelection ?? null;
}

/** Drop the mark without touching the live selection (tab switch, etc.). */
export function clearTranscriptMark(): void {
    lastLiveTranscriptSelection = null;
}

/** Register the mark's abandonment listeners. `onAbandon` runs after each
 *  abandonment so callers can drop companion state (the debounced
 *  quote-capture timer). Install exactly once per document. */
export function installTranscriptMarkGuard(onAbandon?: () => void): void {
    const abandon = (): void => {
        lastLiveTranscriptSelection = null;
        onAbandon?.();
    };
    // A new click abandons the old mark. Keep it for right-click so the
    // context menu can still copy the selection.
    document.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        abandon();
    }, true);
    // Leaving the webview abandons the mark too — see the module doc.
    window.addEventListener('blur', abandon);
}
