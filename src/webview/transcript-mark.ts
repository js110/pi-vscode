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
 *  - explicit clears (tab switch, consumed quote).
 *
 *  Deliberately NO window-blur clearing: VS Code's Cmd/Ctrl+C interception
 *  juggles window focus (take it, then restore it to the webview) while
 *  routing the copy through the webview, so blur cannot distinguish "the
 *  user left the webview" from "the workbench is serving a copy right now"
 *  — clearing on blur broke the in-webview copy (regression in 1.0.2).
 *  Anti-hijack safety comes from elsewhere: a copy intended for the main
 *  editor never routes through the iframe, any click back into the webview
 *  clears the mark, and the deferred composer focus pull is guarded by
 *  document.hasFocus() (captureQuoteFromSelection).
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
    // A new click abandons the old mark. Keep it for right-click so the
    // context menu can still copy the selection.
    document.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        lastLiveTranscriptSelection = null;
        onAbandon?.();
    }, true);
}
