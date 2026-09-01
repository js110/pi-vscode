/**
 * Central gateway to the Pi coding agent SDK.
 *
 * SDK selection strategy (in order):
 *  1. `PI_VSCODE_SDK_PATH` env override, if it points at a copy of the SDK;
 *  2. the system-wide Pi installation (found via the `pi` binary on PATH,
 *     `npm root -g`, or common global locations) — validated against the API
 *     surface this extension uses before it is trusted;
 *  3. the bundled copy in the extension's own node_modules (always present,
 *     tested by CI against the pinned version).
 *
 * Whatever happens, `loadPiSdk()` always returns a working SDK: an
 * incompatible or broken system installation degrades to the bundled copy
 * with a logged reason instead of crashing the session.
 *
 * Every *runtime* `import('@earendil-works/pi-coding-agent')` in the extension
 * must go through `loadPiSdk()` so the module is imported exactly once and
 * the selection is applied consistently. Type-only imports are allowed
 * anywhere: they are erased at compile time and give compile-time breakage
 * detection via `npm run typecheck` (see scripts/check-pi-api.mjs and the
 * pi-canary workflow for the runtime counterpart).
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PKG_NAME = '@earendil-works/pi-coding-agent';
const PKG_SUBPATH = ['@earendil-works', 'pi-coding-agent'] as const;

export type PiSdk = typeof import('@earendil-works/pi-coding-agent');

export interface PiSdkSource {
    /** Where the loaded SDK came from. */
    source: 'system' | 'bundled';
    /** Version string from the loaded copy's package.json. */
    version: string;
    /** Filesystem path of the loaded copy (system copies only). */
    path?: string;
    /** Why the system copy was rejected (set on bundled fallbacks only). */
    reason?: string;
}

let cachedSdk: PiSdk | undefined;
let cachedSource: PiSdkSource | undefined;

/**
 * Load (and cache) the Pi SDK. The SDK is externalized in esbuild and resolved
 * at runtime; system copies are imported by absolute path, the bundled copy by
 * package name (resolved by VS Code's module loader).
 */
export async function loadPiSdk(): Promise<PiSdk> {
    if (!cachedSdk) {
        const loaded = await loadPreferredSdk();
        cachedSdk = loaded.sdk;
        cachedSource = loaded.source;
    }
    return cachedSdk;
}

/** The already-loaded SDK, if any (does not trigger a load). */
export function getLoadedPiSdk(): PiSdk | undefined {
    return cachedSdk;
}

/** Details about which SDK copy was loaded and why. */
export function getSdkSource(): PiSdkSource | undefined {
    return cachedSource;
}

/** True if `obj` has a callable property named `method` (own or inherited). */
export function hasFunction(obj: any, method: string): boolean {
    return typeof obj?.[method] === 'function';
}

// ---------------------------------------------------------------------------
// SDK selection
// ---------------------------------------------------------------------------

async function loadPreferredSdk(): Promise<{ sdk: PiSdk; source: PiSdkSource }> {
    const systemDir = await findSystemSdkDir();
    if (systemDir) {
        const version = readPkgVersion(systemDir) ?? 'unknown';
        try {
            const entry = resolveSdkEntry(systemDir);
            const mod: any = await import(pathToFileURL(entry).href);
            const missing = findMissingApis(mod);
            if (missing.length > 0) {
                const shown = missing.slice(0, 3).join(', ') + (missing.length > 3 ? ', …' : '');
                return await loadBundledSdk(
                    `system Pi ${version} is incompatible (missing APIs: ${shown})`
                );
            }
            return {
                sdk: mod as PiSdk,
                source: { source: 'system', version, path: systemDir },
            };
        } catch (err: any) {
            return await loadBundledSdk(
                `system Pi ${version} at ${systemDir} could not be loaded (${err?.message ?? err})`
            );
        }
    }
    return await loadBundledSdk('no system-wide Pi installation detected');
}

async function loadBundledSdk(reason: string): Promise<{ sdk: PiSdk; source: PiSdkSource }> {
    // NOTE: this import must stay a *string literal*. esbuild inlines the SDK
    // into extension.js for literal dynamic imports, which keeps the bundled
    // fallback available even though the shipped .vsix contains no node_modules.
    // Do not replace it with a variable or the fallback breaks after install.
    const sdk = await import('@earendil-works/pi-coding-agent');
    return {
        sdk,
        source: { source: 'bundled', version: readBundledVersion(), reason },
    };
}

/**
 * Locate a system-wide installation of the SDK. Order:
 * env override -> `pi` binary on PATH -> `npm root -g` -> common locations.
 * Returns the package directory (…/node_modules/@earendil-works/pi-coding-agent).
 */
async function findSystemSdkDir(): Promise<string | undefined> {
    // 1. Explicit override for power users / testing.
    const override = process.env.PI_VSCODE_SDK_PATH;
    if (override && isSdkDir(override)) {
        return override;
    }

    // 2. The `pi` CLI on PATH. npm places shims (pi, pi.cmd) in the global
    //    bin directory, right next to node_modules.
    const binDir = await findPiBinDir();
    if (binDir) {
        let dir = binDir;
        for (let i = 0; i < 4; i++) {
            const candidate = path.join(dir, ...PKG_SUBPATH);
            if (isSdkDir(candidate)) {
                return candidate;
            }
            const parent = path.dirname(dir);
            if (parent === dir) { break; }
            dir = parent;
        }
    }

    // 3. Ask npm for the global root.
    try {
        const { stdout } = await execFileAsync('npm', ['root', '-g'], { timeout: 5_000 });
        const candidate = path.join(stdout.trim(), ...PKG_SUBPATH);
        if (isSdkDir(candidate)) {
            return candidate;
        }
    } catch {
        /* npm missing or failed — continue */
    }

    // 4. Well-known global install locations.
    for (const candidate of commonGlobalCandidates()) {
        if (isSdkDir(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

async function findPiBinDir(): Promise<string | undefined> {
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const { stdout } = await execFileAsync(cmd, ['pi'], { timeout: 5_000 });
        const first = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0);
        if (first) {
            return path.dirname(first);
        }
    } catch {
        /* pi not on PATH */
    }
    return undefined;
}

function commonGlobalCandidates(): string[] {
    const candidates: string[] = [];
    const add = (root?: string) => {
        if (root) { candidates.push(path.join(root, ...PKG_SUBPATH)); }
    };
    if (process.env.APPDATA) {
        add(path.join(process.env.APPDATA, 'npm', 'node_modules')); // npm -g on Windows
    }
    if (process.env.HOME) {
        add(path.join(process.env.HOME, '.npm-global', 'node_modules'));
        add(path.join(process.env.HOME, '.bun', 'install', 'global', 'node_modules'));
        add(path.join(process.env.HOME, '.local', 'share', 'pnpm', 'global', '5', 'node_modules'));
    }
    add('/usr/local/lib/node_modules');
    add('/usr/lib/node_modules');
    add('/opt/homebrew/lib/node_modules');
    return candidates;
}

function isSdkDir(dir: string): boolean {
    try {
        return fs.existsSync(path.join(dir, 'package.json'));
    } catch {
        return false;
    }
}

/** Resolve the ESM entry point from the package's exports map. */
function resolveSdkEntry(pkgDir: string): string {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const exp = pkg?.exports?.['.'];
    const target: string | undefined =
        (typeof exp === 'string' ? exp : undefined)
        ?? (exp && typeof exp === 'object' ? exp.import ?? exp.default : undefined)
        ?? pkg?.main
        ?? pkg?.module;
    if (!target) {
        throw new Error(`no entry point defined in ${pkgDir}/package.json`);
    }
    return path.join(pkgDir, target);
}

function readPkgVersion(pkgDir: string): string | undefined {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        return pkg?.name === PKG_NAME ? String(pkg.version ?? 'unknown') : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Version of the *bundled* SDK (from its package.json), or 'unknown'.
 * The SDK is ESM-only, so `require.resolve()` cannot see it; walk up from the
 * bundled extension directory instead. In pure-ESM contexts (e.g. vitest)
 * `__dirname` is undefined and we simply report 'unknown'.
 */
function readBundledVersion(): string {
    try {
        if (typeof __dirname === 'string') {
            const { join, dirname } = path;
            let dir = __dirname; // <extension>/out in the bundled extension host
            for (let i = 0; i < 8 && dir !== dirname(dir); i++) {
                const pkgPath = join(dir, 'node_modules', ...PKG_SUBPATH, 'package.json');
                if (fs.existsSync(pkgPath)) {
                    try {
                        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                        if (pkg?.name === PKG_NAME) {
                            return String(pkg.version ?? 'unknown');
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
    return 'unknown';
}

/**
 * Runtime API-surface check: the exports, statics and prototype methods this
 * extension relies on. Mirrors scripts/check-pi-api.mjs; keep them in sync.
 * A system copy missing any of these is rejected in favor of the bundled one.
 */
function findMissingApis(sdk: any): string[] {
    const missing: string[] = [];
    const has = (obj: any, method: string) => typeof obj?.[method] === 'function';

    for (const name of [
        'createAgentSession',
        'SessionManager',
        'DefaultResourceLoader',
        'SettingsManager',
        'getAgentDir',
        'ModelRuntime',
        'ModelRegistry',
        'loadSkills',
    ]) {
        if (sdk?.[name] === undefined) { missing.push(name); }
    }
    for (const m of ['create', 'inMemory', 'open', 'list']) {
        if (!has(sdk?.SessionManager, m)) { missing.push(`SessionManager.${m}`); }
    }
    if (!has(sdk?.SettingsManager, 'create')) { missing.push('SettingsManager.create'); }
    if (!has(sdk?.ModelRuntime, 'create')) { missing.push('ModelRuntime.create'); }
    for (const m of ['getAvailable', 'find']) {
        if (!has(sdk?.ModelRegistry?.prototype, m)) { missing.push(`ModelRegistry#${m}`); }
    }
    for (const m of ['setRuntimeApiKey', 'removeRuntimeApiKey']) {
        if (!has(sdk?.ModelRuntime?.prototype, m)) { missing.push(`ModelRuntime#${m}`); }
    }
    if (!has(sdk?.DefaultResourceLoader?.prototype, 'reload')) {
        missing.push('DefaultResourceLoader#reload');
    }
    return missing;
}
