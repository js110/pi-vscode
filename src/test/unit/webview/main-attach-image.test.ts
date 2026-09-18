// @vitest-environment happy-dom
//
// Exercises the REAL chat webview bootstrap (src/webview/main.ts) inside
// happy-dom with a mock `acquireVsCodeApi`: renders the skeleton, delivers a
// stateSync snapshot, then drives the paperclip attach flow end-to-end
// (file input → change → addImageFiles/addTextAttachments → chips) for both
// images and non-image text/binary files. Catches regressions where
// "selected a file, nothing happened".

import { describe, it, expect } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

interface ApiMock {
    postMessage: (m: any) => void;
    getState: () => unknown;
    setState: (s: unknown) => void;
}

function installHarness(): ApiMock {
    document.body.innerHTML = '<div id="app"></div>';

    const snapshot = {
        sessionId: 's1',
        sessionName: 'Smoke',
        activeTabId: 't1',
        tabs: [{ id: 't1', name: 'Smoke', isActive: true, isStreaming: false, hasNotification: false }],
        messages: [] as any[],
        isStreaming: false,
        tools: [] as string[],
        model: { provider: 'anthropic', id: 'claude-smoke', name: 'Claude Smoke' },
        supportsImages: true,
    };

    const dispatch = (data: ServerMessage): void => {
        window.dispatchEvent(new MessageEvent('message', { data }));
    };

    const api: ApiMock = {
        postMessage: (m: any) => {
            if (m.type === 'getState') {
                setTimeout(() => dispatch({ type: 'stateSync', state: snapshot, images: {} }), 0);
            }
            if (m.type === 'getSkills') {
                setTimeout(() => dispatch({ type: 'skills', skills: [] }), 0);
            }
        },
        getState: () => undefined,
        setState: () => undefined,
    };

    (window as unknown as { acquireVsCodeApi?: () => ApiMock }).acquireVsCodeApi = () => api;
    return api;
}

function pickFile(input: HTMLInputElement, name: string, type: string, content: string): void {
    const file = new File([content], name, type ? { type } : undefined);
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [file],
    });
    input.dispatchEvent(new Event('change'));
}

function pickBinary(input: HTMLInputElement, name: string, type: string): void {
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00])], name, { type });
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [file],
    });
    input.dispatchEvent(new Event('change'));
}

async function nextFrame(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
}

async function imageReadSettled(): Promise<void> {
    await new Promise((r) => setTimeout(r, 120));
}

describe('chat attach-image flow (real main.ts), ' + __filename.split(/[\\/]/).pop()!, () => {
    it('renders a chip when an image is picked', async () => {
        installHarness();

        // The webview bundle runs its init (render skeleton + getState/getSkills
        // handshake) on import.
        await import('../../../webview/main');
        await nextFrame();
        await nextFrame();

        const attachBtn = document.getElementById('btn-attach');
        expect(attachBtn, 'attach (paperclip) button should be rendered').not.toBeNull();

        const input = document.getElementById('image-file-input') as HTMLInputElement | null;
        expect(input, 'hidden file input should be mounted').not.toBeNull();

        // Picking a PNG rides addImageFiles → FileReader → chips.
        pickFile(input!, 'diagram.png', 'image/png', 'png-bytes');
        await imageReadSettled();

        const chips = document.querySelectorAll('.image-chip');
        const container = document.getElementById('image-chips');
        expect(chips.length, 'one chip should appear for an image pick').toBe(1);
        expect(chips[0].querySelector('.image-chip-thumb')).not.toBeNull();
        expect(container?.style.display).not.toBe('none');

        // Picking a non-image text file attaches it as a content chip.
        pickFile(input!, 'notes.md', 'text/markdown', 'hello markdown body');
        await imageReadSettled();
        const attachChips = document.querySelectorAll('.attach-chip');
        expect(attachChips.length, 'non-image text pick attaches one chip').toBe(1);
        expect(attachChips[0].querySelector('.attach-chip-name')?.textContent).toBe('notes.md');

        // A binary non-image file is rejected with a visible notice, not a chip.
        pickBinary(input!, 'bundle.zip', 'application/zip');
        await imageReadSettled();
        expect(document.querySelectorAll('.attach-chip').length, 'binary pick adds no chip').toBe(1);
        const notices = document.querySelectorAll('#messages .notice-toast');
        expect(notices.length, 'binary pick surfaces a visible notice').toBeGreaterThan(0);
        expect(notices[notices.length - 1].textContent).toContain('bundle.zip');
    });
});