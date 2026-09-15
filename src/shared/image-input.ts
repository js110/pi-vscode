/**
 * Pure helpers for image input (PRD C6): the webview collects images as
 * `data:` URLs (paste / file picker / drag-drop), the host converts them into
 * the pi SDK's ImageContent payloads before calling session.prompt().
 */

export const MAX_IMAGES_PER_PROMPT = 4;

/** Upper bound per image, decoded bytes (pi providers reject huge payloads). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Structurally compatible with the pi SDK's ImageContent. */
export interface ImagePayload {
    type: 'image';
    mimeType: string;
    data: string;
}

/** Parse a `data:<mime>;base64,<payload>` URL into mime + raw base64. */
export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
    const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
        dataUrl.trim(),
    );
    if (!match) return null;
    return { mimeType: match[1].toLowerCase(), data: match[2].replace(/\s+/g, '') };
}

/** Whether a pi model accepts image input (models expose `input: ("text"|"image")[]`). */
export function modelSupportsImages(model: { input?: unknown } | undefined | null): boolean {
    return Array.isArray(model?.input) && (model.input as unknown[]).includes('image');
}

export type PrepareImagesResult =
    | { ok: true; images: ImagePayload[] }
    | { ok: false; reason: 'invalid'; index: number }
    | { ok: false; reason: 'tooLarge'; index: number; bytes: number }
    | { ok: false; reason: 'tooMany'; count: number };

/** Approximate decoded byte size of a base64 payload (whitespace already stripped). */
function base64Bytes(payload: string): number {
    return Math.floor((payload.length * 3) / 4);
}

/** Raster formats accepted from the webview; svg is scriptable and excluded. */
const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp|bmp)$/;

/** Validate + convert data URLs, enforcing per-image size and per-prompt count. */
export function preparePromptImages(dataUrls: string[]): PrepareImagesResult {
    if (dataUrls.length > MAX_IMAGES_PER_PROMPT) {
        return { ok: false, reason: 'tooMany', count: dataUrls.length };
    }
    const images: ImagePayload[] = [];
    for (let i = 0; i < dataUrls.length; i++) {
        const parsed = parseDataUrl(dataUrls[i]);
        if (!parsed || !IMAGE_MIME_RE.test(parsed.mimeType)) {
            return { ok: false, reason: 'invalid', index: i };
        }
        const bytes = base64Bytes(parsed.data);
        if (bytes > MAX_IMAGE_BYTES) {
            return { ok: false, reason: 'tooLarge', index: i, bytes };
        }
        images.push({ type: 'image', mimeType: parsed.mimeType, data: parsed.data });
    }
    return { ok: true, images };
}
