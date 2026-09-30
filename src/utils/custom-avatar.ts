import * as fs from 'fs';
import * as path from 'path';

/** Storage for the user-uploaded avatar images (Pi + the user, extension
 *  global storage). Each slot keeps a stable `pi-avatar.<ext>` /
 *  `user-avatar.<ext>` name so the webview only needs the directory. */

export type AvatarSlot = 'pi' | 'user';

const AVATAR_RE = /^(pi|user)-avatar\.(png|jpe?g|webp|gif)$/i;
const EXT_RE = /^\.(png|jpe?g|webp|gif)$/;
const SLOT_PREFIX: Record<AvatarSlot, string> = { pi: 'pi-avatar', user: 'user-avatar' };

/** Absolute path of the uploaded image for `slot`, or undefined when absent.
 *  Sync by design: called while building the webview shell. */
export function avatarPathSync(storageDir: string, slot: AvatarSlot): string | undefined {
    try {
        const prefix = SLOT_PREFIX[slot];
        const hit = fs.readdirSync(storageDir).find(
            (e) => AVATAR_RE.test(e) && e.toLowerCase().startsWith(prefix),
        );
        return hit ? path.join(storageDir, hit) : undefined;
    } catch {
        return undefined;
    }
}

export interface AvatarInfo {
    /** Absolute path of the stored image. */
    path: string;
    /** File mtime (ms). Each slot keeps a stable filename across re-uploads,
     *  so the webview URI would otherwise be identical after a replace and
     *  Chromium would keep serving the cached old image. Surfacing the mtime
     *  lets callers append a `?v=` cache-buster. */
    version: number;
}

/** Path + cache-busting version of the stored image for `slot`, or undefined
 *  when absent. Sync like avatarPathSync: called while building state pushes. */
export function avatarInfoSync(storageDir: string, slot: AvatarSlot): AvatarInfo | undefined {
    const p = avatarPathSync(storageDir, slot);
    if (!p) return undefined;
    try {
        return { path: p, version: Math.round(fs.statSync(p).mtimeMs) };
    } catch {
        return { path: p, version: 0 };
    }
}

/** Copy a picked image into storage under the slot's stable name, replacing
 *  any previous upload for that slot (the other slot is untouched). */
export async function saveAvatar(storageDir: string, slot: AvatarSlot, sourcePath: string): Promise<string> {
    await fs.promises.mkdir(storageDir, { recursive: true });
    const ext = path.extname(sourcePath).toLowerCase();
    const safeExt = EXT_RE.test(ext) ? ext : '.png';
    const prefix = SLOT_PREFIX[slot];
    try {
        const entries = await fs.promises.readdir(storageDir);
        await Promise.all(
            entries
                .filter((e) => AVATAR_RE.test(e) && e.toLowerCase().startsWith(prefix))
                .map((e) => fs.promises.unlink(path.join(storageDir, e))),
        );
    } catch {
        // directory absent — will be created above; nothing to clean
    }
    const dest = path.join(storageDir, `${prefix}${safeExt}`);
    await fs.promises.copyFile(sourcePath, dest);
    return dest;
}

/** Remove the uploaded image for `slot`; never throws. */
export async function clearAvatar(storageDir: string, slot: AvatarSlot): Promise<void> {
    const prefix = SLOT_PREFIX[slot];
    try {
        const entries = await fs.promises.readdir(storageDir);
        await Promise.all(
            entries
                .filter((e) => AVATAR_RE.test(e) && e.toLowerCase().startsWith(prefix))
                .map((e) => fs.promises.unlink(path.join(storageDir, e))),
        );
    } catch {
        // directory absent — nothing to clear
    }
}