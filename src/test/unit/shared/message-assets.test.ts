import { describe, it, expect } from 'vitest';
import { collectAndReplaceImages, toImageDataUrl } from '../../../shared/message-assets';

const PNG = 'iVBORw0KGgo=';
const JPEG = '/9j/4AAQ';

function imageMessage(data: string, mimeType = 'image/png'): any {
    return {
        role: 'user',
        content: [
            { type: 'text', text: 'look' },
            { type: 'image', data, mimeType },
        ],
    };
}

describe('collectAndReplaceImages', () => {
    it('replaces image content items with assetId refs and reports the new assets', () => {
        const known = new Map<string, string>();
        let seq = 0;
        const { messages, images } = collectAndReplaceImages(
            [imageMessage(PNG)],
            known,
            () => `img-${++seq}`,
        );

        expect(messages[0].content[1]).toEqual({ type: 'image', assetId: 'img-1' });
        expect(images).toEqual({ 'img-1': `data:image/png;base64,${PNG}` });
        // The input message is not mutated.
        expect(messages[0].content[1]).not.toBe(imageMessage(PNG).content[1]);
    });

    it('reuses a stable assetId when the same image appears again', () => {
        const known = new Map<string, string>();
        let seq = 0;
        const alloc = () => `img-${++seq}`;

        collectAndReplaceImages([imageMessage(PNG)], known, alloc);
        const second = collectAndReplaceImages([imageMessage(PNG)], known, alloc);

        expect(second.messages[0].content[1]).toEqual({ type: 'image', assetId: 'img-1' });
        expect(second.images).toBeUndefined();
    });

    it('reports only genuinely new images when a message mixes old and new ones', () => {
        const known = new Map<string, string>();
        let seq = 0;
        const alloc = () => `img-${++seq}`;

        collectAndReplaceImages([imageMessage(PNG)], known, alloc);
        const { images } = collectAndReplaceImages(
            [imageMessage(PNG), imageMessage(JPEG, 'image/jpeg')],
            known,
            alloc,
        );

        expect(Object.keys(images ?? {})).toEqual(['img-2']);
        expect(images?.['img-2']).toBe(`data:image/jpeg;base64,${JPEG}`);
    });

    it('leaves messages without images at the original reference', () => {
        const known = new Map<string, string>();
        const text = { role: 'user', content: [{ type: 'text', text: 'hi' }] };

        const { messages, images } = collectAndReplaceImages([text], known, () => 'x');

        expect(messages).toEqual([text]);
        expect(messages[0]).toBe(text);
        expect(images).toBeUndefined();
    });

    it('is idempotent over already-replaced assetId items', () => {
        const known = new Map<string, string>();
        const replaced = {
            role: 'user',
            content: [{ type: 'image', assetId: 'img-1' }],
        };

        const { messages, images } = collectAndReplaceImages([replaced], known, () => 'other');

        expect(messages[0]).toBe(replaced);
        expect(images).toBeUndefined();
    });

    it('handles image_url items and string content safely', () => {
        const known = new Map<string, string>();
        let seq = 0;
        const { messages, images } = collectAndReplaceImages(
            [
                { role: 'user', content: [{ type: 'image_url', data: PNG, mimeType: 'image/png' }] },
                { role: 'assistant', content: 'plain text' },
            ],
            known,
            () => `img-${++seq}`,
        );

        expect(messages[0].content[0]).toEqual({ type: 'image', assetId: 'img-1' });
        expect(images?.['img-1']).toBe(`data:image/png;base64,${PNG}`);
        expect(messages[1].content).toBe('plain text');
    });

    it('falls back to image/png when the mime type is bogus', () => {
        const known = new Map<string, string>();
        const { images } = collectAndReplaceImages(
            [imageMessage(PNG, 'not a mime')],
            known,
            () => 'img-1',
        );
        expect(images?.['img-1']).toBe(`data:image/png;base64,${PNG}`);
    });

    it('treats a null data item as untouched', () => {
        const known = new Map<string, string>();
        const msg = { role: 'user', content: [{ type: 'image', data: null }] };
        const { messages, images } = collectAndReplaceImages([msg], known, () => 'img-1');
        expect(messages[0]).toBe(msg);
        expect(images).toBeUndefined();
    });
});

describe('toImageDataUrl', () => {
    it('keeps a valid mime type', () => {
        expect(toImageDataUrl(PNG, 'image/jpeg')).toBe(`data:image/jpeg;base64,${PNG}`);
    });
    it('defaults to image/png', () => {
        expect(toImageDataUrl(PNG, undefined)).toBe(`data:image/png;base64,${PNG}`);
    });
});
