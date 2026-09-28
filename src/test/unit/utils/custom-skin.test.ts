import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { customSkinPathSync, saveCustomSkin, clearCustomSkin } from '../../../utils/custom-skin';

describe('custom-skin storage', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skin-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reports no upload when the directory is empty or missing', () => {
        expect(customSkinPathSync(dir)).toBeUndefined();
        expect(customSkinPathSync(path.join(dir, 'missing'))).toBeUndefined();
    });

    it('saves a picked image under the stable custom-skin name', async () => {
        const source = path.join(dir, 'pick.png');
        fs.writeFileSync(source, Buffer.from('png-bytes'));
        const dest = await saveCustomSkin(dir, source);
        expect(dest).toBe(path.join(dir, 'custom-skin.png'));
        expect(fs.readFileSync(dest).toString()).toBe('png-bytes');
        expect(customSkinPathSync(dir)).toBe(dest);
    });

    it('keeps the extension of a jpeg pick', async () => {
        const source = path.join(dir, 'photo.JPEG');
        fs.writeFileSync(source, Buffer.from('jpeg-bytes'));
        const dest = await saveCustomSkin(dir, source);
        expect(path.basename(dest)).toBe('custom-skin.jpeg');
        expect(customSkinPathSync(dir)).toBe(dest);
    });

    it('replaces an earlier upload instead of stacking files', async () => {
        const a = path.join(dir, 'a.png');
        const b = path.join(dir, 'b.webp');
        fs.writeFileSync(a, Buffer.from('A'));
        fs.writeFileSync(b, Buffer.from('B'));
        await saveCustomSkin(dir, a);
        await saveCustomSkin(dir, b);
        const files = fs.readdirSync(dir).filter((e) => e.includes('custom-skin'));
        expect(files).toEqual(['custom-skin.webp']);
        expect(fs.readFileSync(path.join(dir, 'custom-skin.webp')).toString()).toBe('B');
    });

    it('clearCustomSkin removes the upload and is a no-op when absent', async () => {
        const source = path.join(dir, 'a.png');
        fs.writeFileSync(source, Buffer.from('A'));
        await saveCustomSkin(dir, source);
        await clearCustomSkin(dir);
        expect(customSkinPathSync(dir)).toBeUndefined();
        await expect(clearCustomSkin(path.join(dir, 'missing'))).resolves.toBeUndefined();
        await expect(clearCustomSkin(dir)).resolves.toBeUndefined();
    });
});