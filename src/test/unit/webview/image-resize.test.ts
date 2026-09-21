// @vitest-environment happy-dom
//
// Covers the webview image normalization: small files pass through as data
// URLs, non-image data is flagged invalid, and anything above the 5 MB send
// cap only succeeds if the (environment-dependent) canvas path can re-encode
// it — in happy-dom there is no canvas, so oversized input surfaces as
// tooLarge.

import { describe, it, expect } from 'vitest';
import {
    normalizeImageFile,
    MAX_IMAGE_INPUT_BYTES,
    MAX_IMAGE_EDGE_PX,
} from '../../../webview/image-resize';
import { MAX_IMAGE_BYTES } from '../../../shared/image-input';

describe('normalizeImageFile', () => {
    it('passes a small image through as a data URL', async () => {
        const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', {
            type: 'image/png',
        });
        const res = await normalizeImageFile(file);
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('flags small non-image data as invalid', async () => {
        const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
        const res = await normalizeImageFile(file);
        expect(res).toEqual({ ok: false, reason: 'invalid' });
    });

    it('derives the MIME from the name when the File type is empty (Windows OS drag)', async () => {
        const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png');
        expect(file.type).toBe('');
        const res = await normalizeImageFile(file);
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('still flags a non-image name with an empty type as invalid', async () => {
        const file = new File(['hello'], 'notes.txt');
        expect(file.type).toBe('');
        const res = await normalizeImageFile(file);
        expect(res).toEqual({ ok: false, reason: 'invalid' });
    });

    it('rejects files above the 25 MB accept cap outright', async () => {
        expect(MAX_IMAGE_INPUT_BYTES).toBeGreaterThan(MAX_IMAGE_BYTES);
        const file = new File([new Uint8Array(MAX_IMAGE_INPUT_BYTES + 1)], 'big.png', {
            type: 'image/png',
        });
        const res = await normalizeImageFile(file);
        expect(res).toEqual({ ok: false, reason: 'tooLarge' });
    });

    it('surfaces oversized files as tooLarge when canvas is unavailable', async () => {
        const file = new File([new Uint8Array(MAX_IMAGE_BYTES + 1024)], 'huge.png', {
            type: 'image/png',
        });
        const res = await normalizeImageFile(file);
        expect(res).toEqual({ ok: false, reason: 'tooLarge' });
    });

    it('caps the re-encode long edge at the API-usable resolution', () => {
        expect(MAX_IMAGE_EDGE_PX).toBe(2576);
    });
});
