import { describe, it, expect } from 'vitest';
import {
    parseDataUrl,
    modelSupportsImages,
    preparePromptImages,
    MAX_IMAGES_PER_PROMPT,
    MAX_IMAGE_BYTES,
} from '../../../shared/image-input';

const PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('parseDataUrl', () => {
    it('parses a base64 image data URL', () => {
        const parsed = parseDataUrl(PNG_DATA_URL);
        expect(parsed).not.toBeNull();
        expect(parsed!.mimeType).toBe('image/png');
        expect(parsed!.data).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('rejects non-image payloads and malformed URLs', () => {
        expect(parseDataUrl('https://example.com/x.png')).toBeNull();
        expect(parseDataUrl('data:image/png;base64,not!!base64')).toBeNull();
        expect(parseDataUrl('data:image/png,rawbytes')).toBeNull();
        expect(parseDataUrl('')).toBeNull();
    });
});

describe('modelSupportsImages', () => {
    it('is true when the model input list includes image', () => {
        expect(modelSupportsImages({ input: ['text', 'image'] })).toBe(true);
        expect(modelSupportsImages({ input: ['image'] })).toBe(true);
    });

    it('is false for text-only, missing, or malformed input', () => {
        expect(modelSupportsImages({ input: ['text'] })).toBe(false);
        expect(modelSupportsImages({})).toBe(false);
        expect(modelSupportsImages(undefined)).toBe(false);
        expect(modelSupportsImages({ input: 'image' })).toBe(false);
    });
});

describe('preparePromptImages', () => {
    it('converts data URLs into SDK image payloads', () => {
        const result = preparePromptImages([PNG_DATA_URL]);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.images).toHaveLength(1);
            expect(result.images[0]).toEqual({
                type: 'image',
                mimeType: 'image/png',
                data: expect.stringMatching(/^[A-Za-z0-9+/=]+$/),
            });
        }
    });

    it('rejects an invalid data URL with its index', () => {
        const result = preparePromptImages([PNG_DATA_URL, 'data:image/png;base64,###']);
        expect(result).toEqual({ ok: false, reason: 'invalid', index: 1 });
    });

    it('restricts the mime type to raster images', () => {
        expect(preparePromptImages(['data:text/html;base64,PGh0bWw+'])).toEqual({
            ok: false,
            reason: 'invalid',
            index: 0,
        });
        // svg is scriptable — excluded on purpose.
        expect(preparePromptImages(['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='])).toEqual({
            ok: false,
            reason: 'invalid',
            index: 0,
        });
        const webp = preparePromptImages(['data:image/webp;base64,UklGRh4=']);
        expect(webp.ok).toBe(true);
    });

    it('rejects oversized images', () => {
        // (MAX_IMAGE_BYTES * 4 / 3) base64 chars ≈ MAX_IMAGE_BYTES decoded bytes.
        const big = `data:image/png;base64,${'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8)}`;
        const result = preparePromptImages([big]);
        expect(result.ok).toBe(false);
        if (!result.ok && result.reason === 'tooLarge') {
            expect(result.index).toBe(0);
            expect(result.bytes).toBeGreaterThan(MAX_IMAGE_BYTES);
        }
    });

    it('rejects more than the per-prompt maximum', () => {
        const result = preparePromptImages(Array(MAX_IMAGES_PER_PROMPT + 1).fill(PNG_DATA_URL));
        expect(result).toEqual({ ok: false, reason: 'tooMany', count: MAX_IMAGES_PER_PROMPT + 1 });
    });
});
