/** Panel skins: colour-accent presets + a decorative background layer.
 *  The list is the single source of truth for the package.json enum, the
 *  settings dropdown, and the `data-skin` attribute injected into both
 *  webview shells (anything unknown normalizes back to `default`).
 *
 *  `custom` is the user's own uploaded image; it only renders when the file
 *  actually exists — see effectiveSkin(). */

export const SKIN_IDS = ['default', 'aurora', 'graphite', 'sunset', 'custom'] as const;

export type SkinId = (typeof SKIN_IDS)[number];

export const DEFAULT_SKIN: SkinId = 'default';

export function normalizeSkin(value: unknown): SkinId {
    return (SKIN_IDS as readonly unknown[]).includes(value as SkinId)
        ? (value as SkinId)
        : DEFAULT_SKIN;
}

/** The skin the panel should actually render: `custom` degrades to
 *  `default` when no uploaded image is on disk (fresh install, cleared
 *  storage, corrupt config). */
export function effectiveSkin(configured: unknown, customSkinAvailable: boolean): SkinId {
    const skin = normalizeSkin(configured);
    return skin === 'custom' && !customSkinAvailable ? DEFAULT_SKIN : skin;
}
