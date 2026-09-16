/**
 * Image asset separation for stateSync (T16): persisted messages carry base64
 * image payloads; shipping them on every stateSync frame is quadratic. This
 * module rewrites image content items into stable assetId references so the
 * actual data travels once, out of band.
 */

const MIME_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

export function toImageDataUrl(data: string, mimeType: unknown): string {
    const mime = typeof mimeType === 'string' && MIME_PATTERN.test(mimeType) ? mimeType : 'image/png';
    return `data:${mime};base64,${data}`;
}

function isImageItem(c: any): boolean {
    return !!c && (c.type === 'image' || c.type === 'image_url') && typeof c.data === 'string' && c.data.length > 0;
}

/**
 * Replace image content items with `{ type: 'image', assetId }` references.
 * `known` maps the image payload to an already-allocated assetId so the same
 * picture keeps one id across frames; `allocId` mints new ids. Messages are
 * never mutated — items without images keep their original object reference.
 * `images` contains only assets first seen in this call.
 */
export function collectAndReplaceImages(
    messages: readonly any[],
    known: Map<string, string>,
    allocId: () => string,
): { messages: any[]; images?: Record<string, string> } {
    let replacedAny = false;
    const newImages: Record<string, string> = {};

    const out = messages.map((msg) => {
        if (!msg || !Array.isArray(msg.content) || !msg.content.some(isImageItem)) {
            return msg;
        }
        const content = msg.content.map((c: any) => {
            if (!isImageItem(c)) return c;
                        // NUL separator keeps mime+payload unambiguous (a space could
            // collide); written as an escape so the file stays plain text.
const key = `${c.mimeType}\u0000${c.data}`;
            let assetId = known.get(key);
            if (assetId === undefined) {
                assetId = allocId();
                known.set(key, assetId);
                newImages[assetId] = toImageDataUrl(c.data, c.mimeType);
            }
            replacedAny = true;
            return { type: 'image', assetId };
        });
        return { ...msg, content };
    });

    return { messages: out, images: replacedAny && Object.keys(newImages).length > 0 ? newImages : undefined };
}
