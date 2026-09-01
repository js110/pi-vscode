/**
 * Central gateway to the Pi coding agent SDK.
 *
 * Every *runtime* `import('@earendil-works/pi-coding-agent')` in the extension
 * must go through `loadPiSdk()` so that:
 *  - the module is imported exactly once and cached;
 *  - the installed SDK version is captured for diagnostics;
 *  - future SDK refactorings only require touching this file.
 *
 * Type-only imports (`import type { ... } from '@earendil-works/pi-coding-agent'`)
 * elsewhere are fine: they are erased at compile time and give us compile-time
 * breakage detection via `npm run typecheck` (see scripts/check-pi-api.mjs and
 * the pi-canary workflow for the runtime counterpart).
 */

export type PiSdk = typeof import('@earendil-works/pi-coding-agent');

let cachedSdk: PiSdk | undefined;
let cachedVersion: string | undefined;

/**
 * Load (and cache) the Pi SDK. The SDK is externalized in esbuild and resolved
 * at runtime by VS Code's module loader, so this must stay a dynamic import.
 */
export async function loadPiSdk(): Promise<PiSdk> {
    if (!cachedSdk) {
        cachedSdk = await import('@earendil-works/pi-coding-agent');
    }
    return cachedSdk;
}

/** The already-loaded SDK, if any (does not trigger a load). */
export function getLoadedPiSdk(): PiSdk | undefined {
    return cachedSdk;
}

/**
 * Version of the *installed* SDK (from its package.json), or 'unknown'.
 *
 * The SDK is ESM-only, so `require.resolve()` cannot see it. Instead we walk
 * up from the bundled extension directory looking for its package.json.
 * In pure-ESM contexts (e.g. vitest) `__dirname` is undefined and we simply
 * report 'unknown'; nothing depends on this value being exact.
 */
export function getInstalledPiVersion(): string {
    if (cachedVersion !== undefined) {
        return cachedVersion;
    }
    try {
        if (typeof __dirname === 'string') {
            const { join, dirname } = require('node:path') as typeof import('node:path');
            const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
            let dir = __dirname; // <extension>/out in the bundled extension host
            for (let i = 0; i < 8 && dir !== dirname(dir); i++) {
                const pkgPath = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
                if (existsSync(pkgPath)) {
                    try {
                        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
                        if (pkg?.name === '@earendil-works/pi-coding-agent') {
                            cachedVersion = String(pkg.version ?? 'unknown');
                            return cachedVersion;
                        }
                    } catch {
                        /* unreadable package.json — keep walking up */
                    }
                }
                dir = dirname(dir);
            }
        }
    } catch {
        /* detection failed — report unknown */
    }
    cachedVersion = 'unknown';
    return cachedVersion;
}

/** True if `obj` has a callable property named `method` (own or inherited). */
export function hasFunction(obj: any, method: string): boolean {
    return typeof obj?.[method] === 'function';
}
