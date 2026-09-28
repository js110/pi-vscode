import * as fs from 'fs';
import * as path from 'path';

/** Storage for the user-uploaded custom-skin image (extension global storage).
 *  The file keeps a stable `custom-skin.<ext>` name so the webview only needs
 *  the directory, never the original filename. */

const CUSTOM_SKIN_RE = /^custom-skin\.(png|jpe?g|webp|gif)$/i;
const EXT_RE = /^\.(png|jpe?g|webp|gif)$/;

/** Absolute path of the uploaded image, or undefined when none exists.
 *  Sync by design: called while building the webview shell. */
export function customSkinPathSync(storageDir: string): string | undefined {
    try {
        const hit = fs.readdirSync(storageDir).find((e) => CUSTOM_SKIN_RE.test(e));
        return hit ? path.join(storageDir, hit) : undefined;
    } catch {
        return undefined;
    }
}

/** Copy a picked image into storage under the stable name, replacing any
 *  previous upload (the extension can change between picks). */
export async function saveCustomSkin(storageDir: string, sourcePath: string): Promise<string> {
    await fs.promises.mkdir(storageDir, { recursive: true });
    const ext = path.extname(sourcePath).toLowerCase();
    const safeExt = EXT_RE.test(ext) ? ext : '.png';
    await clearCustomSkin(storageDir);
    const dest = path.join(storageDir, `custom-skin${safeExt}`);
    await fs.promises.copyFile(sourcePath, dest);
    return dest;
}

/** Remove any uploaded image; never throws (missing dir is a no-op). */
export async function clearCustomSkin(storageDir: string): Promise<void> {
    try {
        const entries = await fs.promises.readdir(storageDir);
        await Promise.all(
            entries
                .filter((e) => CUSTOM_SKIN_RE.test(e))
                .map((e) => fs.promises.unlink(path.join(storageDir, e))),
        );
    } catch {
        // directory absent — nothing to clear
    }
}
