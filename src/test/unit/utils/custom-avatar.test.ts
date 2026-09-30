import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { avatarPathSync, avatarInfoSync, saveAvatar, clearAvatar } from '../../../utils/custom-avatar';

describe('custom-avatar storage', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-avatar-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reports no upload when the directory is empty or missing', () => {
        expect(avatarPathSync(dir, 'pi')).toBeUndefined();
        expect(avatarPathSync(dir, 'user')).toBeUndefined();
        expect(avatarInfoSync(path.join(dir, 'missing'), 'pi')).toBeUndefined();
    });

    it('saves a picked image under the slot\'s stable name', async () => {
        const source = path.join(dir, 'pick.png');
        fs.writeFileSync(source, Buffer.from('png-bytes'));
        const dest = await saveAvatar(dir, 'pi', source);
        expect(dest).toBe(path.join(dir, 'pi-avatar.png'));
        expect(fs.readFileSync(dest).toString()).toBe('png-bytes');
        expect(avatarPathSync(dir, 'pi')).toBe(dest);
        expect(avatarPathSync(dir, 'user')).toBeUndefined();
    });

    it('avatarInfoSync returns the path and a version that changes on re-upload', async () => {
        const a = path.join(dir, 'a.png');
        const b = path.join(dir, 'b.png');
        fs.writeFileSync(a, Buffer.from('A'));
        fs.writeFileSync(b, Buffer.from('B'));

        await saveAvatar(dir, 'pi', a);
        const first = avatarInfoSync(dir, 'pi');
        expect(first?.path).toBe(path.join(dir, 'pi-avatar.png'));
        expect(typeof first?.version).toBe('number');

        // copyFile preserves the source mtime, which may equal the first
        // save's; force distinct mtimes so the version provably tracks time.
        await new Promise((r) => setTimeout(r, 12));
        const future = Date.now() + 5000;
        fs.utimesSync(b, new Date(future), new Date(future));
        await saveAvatar(dir, 'pi', b);
        const second = avatarInfoSync(dir, 'pi');
        expect(second?.path).toBe(first?.path); // stable filename…
        expect(second?.version).toBeGreaterThan(first!.version); // …new version
        expect(avatarInfoSync(dir, 'user')).toBeUndefined();
    });

    it('keeps the extension of a jpeg pick', async () => {
        const source = path.join(dir, 'photo.JPEG');
        fs.writeFileSync(source, Buffer.from('jpeg-bytes'));
        const dest = await saveAvatar(dir, 'user', source);
        expect(path.basename(dest)).toBe('user-avatar.jpeg');
        expect(avatarPathSync(dir, 'user')).toBe(dest);
    });

    it('falls back to .png for an unknown extension', async () => {
        const source = path.join(dir, 'weird.bmp');
        fs.writeFileSync(source, Buffer.from('bmp-bytes'));
        const dest = await saveAvatar(dir, 'pi', source);
        expect(path.basename(dest)).toBe('pi-avatar.png');
    });

    it('replaces an earlier upload for the slot without touching the other', async () => {
        const a = path.join(dir, 'a.png');
        const b = path.join(dir, 'b.webp');
        const u = path.join(dir, 'u.png');
        fs.writeFileSync(a, Buffer.from('A'));
        fs.writeFileSync(b, Buffer.from('B'));
        fs.writeFileSync(u, Buffer.from('U'));
        await saveAvatar(dir, 'pi', a);
        await saveAvatar(dir, 'user', u);
        await saveAvatar(dir, 'pi', b);
        const files = fs.readdirSync(dir).filter((e) => e.includes('-avatar.')).sort();
        expect(files).toEqual(['pi-avatar.webp', 'user-avatar.png']);
        expect(fs.readFileSync(path.join(dir, 'pi-avatar.webp')).toString()).toBe('B');
        expect(fs.readFileSync(path.join(dir, 'user-avatar.png')).toString()).toBe('U');
    });

    it('clearAvatar removes only that slot and is a no-op when absent', async () => {
        const pi = path.join(dir, 'a.png');
        const user = path.join(dir, 'b.png');
        fs.writeFileSync(pi, Buffer.from('A'));
        fs.writeFileSync(user, Buffer.from('B'));
        await saveAvatar(dir, 'pi', pi);
        await saveAvatar(dir, 'user', user);
        await clearAvatar(dir, 'pi');
        expect(avatarPathSync(dir, 'pi')).toBeUndefined();
        expect(avatarPathSync(dir, 'user')).toBe(path.join(dir, 'user-avatar.png'));
        await expect(clearAvatar(path.join(dir, 'missing'), 'pi')).resolves.toBeUndefined();
        await expect(clearAvatar(dir, 'pi')).resolves.toBeUndefined();
    });
});
