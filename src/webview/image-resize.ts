/**
 * Client-side image normalization for the composer: files above the provider's
 * per-image send cap (5 MB) are decoded, downscaled on a canvas, and
 * re-encoded below the cap, so large photos attach instead of bouncing. The
 * long-edge cap mirrors the API's own server-side downscale — anything beyond
 * it is wasted bytes. Canvas APIs are treated as optional: when unavailable
 * (or decoding fails), oversized files surface as tooLarge like before.
 */

import { MAX_IMAGE_BYTES } from '../shared/image-input';

/** Webview accept cap for a picked image file (before compression). */
export const MAX_IMAGE_INPUT_BYTES = 25 * 1024 * 1024;

/** Long edge the API actually consumes; larger is downscaled server-side. */
export const MAX_IMAGE_EDGE_PX = 2576;

const JPEG_QUALITY = 0.85;

export type NormalizeImageResult =
    | { ok: true; dataUrl: string }
    | { ok: false; reason: 'tooLarge' | 'invalid' };

/** Approximate decoded byte size of a `data:<mime>;base64,<payload>` URL. */
function dataUrlDecodedBytes(dataUrl: string): number {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return Infinity;
    return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}

function readAsDataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('read failed'));
        reader.readAsDataURL(file);
    });
}

function canvasToDataUrl(canvas: HTMLCanvasElement, type: string): string | null {
    try {
        return canvas.toDataURL(type, JPEG_QUALITY);
    } catch {
        return null;
    }
}

/** Read an image file, compressing anything above the 5 MB send cap. */
export async function normalizeImageFile(file: File): Promise<NormalizeImageResult> {
    if (file.size > MAX_IMAGE_INPUT_BYTES) return { ok: false, reason: 'tooLarge' };
    if (file.size <= MAX_IMAGE_BYTES) {
        try {
            const dataUrl = await readAsDataUrl(file);
            return dataUrl.startsWith('data:image/')
                ? { ok: true, dataUrl }
                : { ok: false, reason: 'invalid' };
        } catch {
            return { ok: false, reason: 'invalid' };
        }
    }
    try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        try {
            const scale = Math.min(1, MAX_IMAGE_EDGE_PX / Math.max(bitmap.width, bitmap.height));
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) return { ok: false, reason: 'tooLarge' };
            ctx.drawImage(bitmap, 0, 0, width, height);
            const png = canvasToDataUrl(canvas, 'image/png');
            if (png && dataUrlDecodedBytes(png) <= MAX_IMAGE_BYTES) return { ok: true, dataUrl: png };
            const jpeg = canvasToDataUrl(canvas, 'image/jpeg');
            if (jpeg && dataUrlDecodedBytes(jpeg) <= MAX_IMAGE_BYTES) return { ok: true, dataUrl: jpeg };
            return { ok: false, reason: 'tooLarge' };
        } finally {
            bitmap.close();
        }
    } catch {
        return { ok: false, reason: 'tooLarge' };
    }
}
