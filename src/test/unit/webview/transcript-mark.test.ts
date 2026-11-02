// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearTranscriptMark,
    copyTargetText,
    installTranscriptMarkGuard,
    rememberLiveTranscriptSelection,
    transcriptSelectionText,
} from '../../../webview/transcript-mark';

function selectNodeText(node: Element): void {
    document.getSelection()?.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(node);
    document.getSelection()!.addRange(range);
}

beforeEach(() => {
    document.body.innerHTML = `
        <div id="messages">
            <div class="message-content"><p id="msg">selectable transcript text</p></div>
            <div id="outside"><p id="other">not transcript text</p></div>
        </div>`;
    document.getSelection()?.removeAllRanges();
    clearTranscriptMark();
});

describe('transcript selection reading', () => {
    it('reads a live selection inside message content', () => {
        selectNodeText(document.getElementById('msg')!);
        expect(transcriptSelectionText()).toBe('selectable transcript text');
    });

    it('ignores selections outside the transcript message content', () => {
        selectNodeText(document.getElementById('other')!);
        expect(transcriptSelectionText()).toBeNull();
    });

    it('returns null for a collapsed selection', () => {
        expect(transcriptSelectionText()).toBeNull();
    });
});

describe('mark fallback for copy', () => {
    it('falls back to the snapshot once the selection collapses', () => {
        selectNodeText(document.getElementById('msg')!);
        rememberLiveTranscriptSelection();
        // Focus restoration collapses the selection (VS Code behavior).
        document.getSelection()?.removeAllRanges();
        expect(transcriptSelectionText()).toBeNull();
        expect(copyTargetText()).toBe('selectable transcript text');
    });

    it('only snapshots selections inside message content', () => {
        selectNodeText(document.getElementById('other')!);
        rememberLiveTranscriptSelection();
        document.getSelection()?.removeAllRanges();
        expect(copyTargetText()).toBeNull();
    });
});

describe('mark abandonment (regression: stale mark hijacked Cmd+C)', () => {
    function markMessageSelection(): void {
        selectNodeText(document.getElementById('msg')!);
        rememberLiveTranscriptSelection();
        document.getSelection()?.removeAllRanges();
    }

    it('a left click drops the mark, a right click keeps it', () => {
        installTranscriptMarkGuard();
        markMessageSelection();
        document.dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true }));
        expect(copyTargetText()).toBe('selectable transcript text');
        document.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
        expect(copyTargetText()).toBeNull();
    });

    it('abandonment runs the companion cleanup callback', () => {
        const onAbandon = vi.fn();
        installTranscriptMarkGuard(onAbandon);
        markMessageSelection();
        document.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
        expect(onAbandon).toHaveBeenCalledTimes(1);
    });

    it('does NOT clear the mark on window blur (VS Code copy interception juggles focus)', () => {
        installTranscriptMarkGuard();
        markMessageSelection();
        window.dispatchEvent(new Event('blur'));
        expect(copyTargetText()).toBe('selectable transcript text');
    });
});
