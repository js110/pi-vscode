#!/usr/bin/env node
/**
 * Pi SDK API surface audit.
 *
 * Verifies that every SDK export, static method and prototype method the
 * pi-vscode extension relies on still exists in the *installed* copy of
 * @earendil-works/pi-coding-agent. Run after any SDK upgrade:
 *
 *   node scripts/check-pi-api.mjs
 *
 * Exits non-zero and lists missing APIs so CI (see .github/workflows/
 * pi-canary.yml) can catch breaking upstream changes early.
 *
 * When the extension starts using a new SDK API, add a check for it here.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The SDK is ESM-only (its exports map defines no CJS main), so load it via
// dynamic import instead of require.
let sdk;
try {
    sdk = await import('@earendil-works/pi-coding-agent');
} catch (err) {
    console.error(`FAIL: cannot load @earendil-works/pi-coding-agent: ${err?.message ?? err}`);
    process.exit(1);
}

const pkgVersion = (() => {
    try {
        const entryUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
        let dir = dirname(fileURLToPath(entryUrl));
        for (let i = 0; i < 8 && dir !== dirname(dir); i++) {
            const p = join(dir, 'package.json');
            if (existsSync(p)) {
                const pkg = JSON.parse(readFileSync(p, 'utf8'));
                if (pkg?.name === '@earendil-works/pi-coding-agent') {
                    return String(pkg.version ?? 'unknown');
                }
            }
            dir = dirname(dir);
        }
    } catch {
        /* fall through */
    }
    return 'unknown';
})();

const missing = [];

function checkExport(name) {
    if (sdk?.[name] === undefined) { missing.push(`export: ${name}`); }
}

function checkStatic(objName, method) {
    const obj = sdk?.[objName];
    if (typeof obj?.[method] !== 'function') { missing.push(`${objName}.${method} (static)`); }
}

function checkProto(objName, method) {
    const obj = sdk?.[objName];
    if (typeof obj?.prototype?.[method] !== 'function') { missing.push(`${objName}#${method}`); }
}

// --- Module exports used by the extension (src/pi/*) ---
[
    'createAgentSession',
    'SessionManager',
    'DefaultResourceLoader',
    'SettingsManager',
    'getAgentDir',
    'ModelRuntime',
    'ModelRegistry',
    'loadSkills',
].forEach(checkExport);

// --- Static factories / helpers ---
['create', 'inMemory', 'open', 'list'].forEach((m) => checkStatic('SessionManager', m));
checkStatic('SettingsManager', 'create');
checkStatic('ModelRuntime', 'create');

// --- Instance methods (checked on prototypes, no instantiation needed) ---
['getAvailable', 'find'].forEach((m) => checkProto('ModelRegistry', m));
['setRuntimeApiKey', 'removeRuntimeApiKey'].forEach((m) => checkProto('ModelRuntime', m));
checkProto('DefaultResourceLoader', 'reload');

// AgentSession instance methods cannot be checked without creating a live
// session (needs a model); they are covered by `npm run typecheck` (SDK .d.ts)
// and the unit tests, which build a real session.

if (missing.length) {
    console.error(`Pi SDK API audit (installed version ${pkgVersion}): ${missing.length} missing API(s):`);
    for (const m of missing) {
        console.error(`  - ${m}`);
    }
    console.error('\nUpdate src/pi/compat.ts / feature-detect the API, or pin an older SDK version.');
    process.exit(1);
}

console.log(`Pi SDK API audit (installed version ${pkgVersion}): all required APIs present.`);
