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

const sdkPkg = (() => {
    try {
        const entryUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
        let dir = dirname(fileURLToPath(entryUrl));
        for (let i = 0; i < 8 && dir !== dirname(dir); i++) {
            const p = join(dir, 'package.json');
            if (existsSync(p)) {
                const pkg = JSON.parse(readFileSync(p, 'utf8'));
                if (pkg?.name === '@earendil-works/pi-coding-agent') {
                    return { version: String(pkg.version ?? 'unknown'), dir };
                }
            }
            dir = dirname(dir);
        }
    } catch {
        /* fall through */
    }
    return { version: 'unknown', dir: undefined };
})();
const pkgVersion = sdkPkg.version;
const sdkRoot = sdkPkg.dir;

const missing = [];

function versionAtLeast(installed, min) {
    const pa = String(installed).split('.').map(Number);
    const pb = String(min).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const da = pa[i] ?? 0;
        const db = pb[i] ?? 0;
        if (da !== db) return da > db;
    }
    return true;
}

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

/**
 * Assert that a token still appears in an installed .d.ts file. Use for
 * option/event *fields* (e.g. `excludeTools`, `agent_settled.aborted`) that
 * no export/prototype check can see — a rename there would otherwise slip
 * through typecheck only if the extension's own reads are also gone.
 */
function checkTypeToken(relPath, token) {
    if (!sdkRoot) return;
    try {
        const text = readFileSync(join(sdkRoot, relPath), 'utf8');
        if (!text.includes(token)) missing.push(`types: ${relPath} → "${token}"`);
    } catch (err) {
        missing.push(`types: ${relPath} unreadable (${err?.code ?? err?.message ?? err})`);
    }
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
['setRuntimeApiKey', 'removeRuntimeApiKey', 'completeSimple', 'getAvailableSnapshot']
    .forEach((m) => checkProto('ModelRuntime', m));
checkProto('DefaultResourceLoader', 'reload');
if (pkgVersion !== 'unknown' && versionAtLeast(pkgVersion, '1.0.0')) {
    ['AgentSessionRuntime', 'createAgentSessionServices', 'createAgentSessionFromServices', 'ProjectTrustStore'].forEach(checkExport);
    ['fork', 'importFromJsonl', 'setRebindSession', 'newSession', 'switchSession', 'dispose'].forEach(m => checkProto('AgentSessionRuntime', m));
    ['reload', 'navigateTree', 'getUserMessagesForForking', 'exportToHtml', 'exportToJsonl', 'setScopedModels', 'bindExtensions', 'waitForIdle'].forEach(m => checkProto('AgentSession', m));
    ['getTree', 'getLeafId', 'getCwd', 'getEntry', 'appendLabelChange'].forEach(m => checkProto('SessionManager', m));
    ['getCommand', 'createCommandContext'].forEach(m => checkProto('ExtensionRunner', m));
    // The tool-approval hook monkey-patches ExtensionRunner.emitToolCall
    // (src/pi/session.ts). A rename there does NOT throw — the patch just
    // lands on a dead property and every approval silently bypasses — so it
    // must be part of the audit, not merely typecheck-covered.
    checkProto('ExtensionRunner', 'emitToolCall');
    ['Theme', 'initTheme', 'createMcpExtension', 'createCodemodeExtension', 'createToolSearchExtension'].forEach(checkExport);
    ['login', 'logout', 'listCredentials', 'getProviders', 'getProvider', 'getAvailableSnapshot'].forEach(m => checkProto('ModelRuntime', m));
    checkProto('ProjectTrustStore', 'set');
    checkProto('SettingsManager', 'setEnabledModels');
}

// --- Version-gated APIs (cache warming, SDK 0.86.0+) ---
// The pinned bundled copy (0.84.4) predates cache warming, and the extension
// feature-detects every one of these at runtime (src/pi/session.ts), so a
// missing API is only a hard error once Pi ships >= 0.86.0 — the canary run
// will catch a rename/removal on the next SDK bump.
if (pkgVersion !== 'unknown' && versionAtLeast(pkgVersion, '0.86.0')) {
    ['getCacheWarmingMode', 'setCacheWarmingMode'].forEach((m) => checkProto('SettingsManager', m));
}

// --- Version-gated APIs (Pi 1.1.0+): session denylist and run/status fields ---
// The extension reads these unconditionally on 1.1.0+ (session tool options,
// agent_settled.aborted, tool durationMs); gate so an older pinned copy only
// warns via the canary's latest-SDK run.
if (pkgVersion !== 'unknown' && versionAtLeast(pkgVersion, '1.1.0')) {
    checkTypeToken('dist/core/sdk.d.ts', 'excludeTools');
    checkTypeToken('dist/core/agent-session.d.ts', 'aborted: boolean');
    checkTypeToken('dist/core/extensions/types.d.ts', 'durationMs');
}

// AgentSession instance methods cannot be checked without creating a live
// session (needs a model); they are covered by `npm run typecheck` (SDK .d.ts)
// and the unit tests, which build a real session. Its cache-warming and
// bug-report APIs are feature-detected in src/pi/session.ts. The `model`
// property read in src/extension.ts (auto-naming) is also typecheck-covered —
// its class getter dereferences session state, so it can't be probed here.

if (missing.length) {
    console.error(`Pi SDK API audit (installed version ${pkgVersion}): ${missing.length} missing API(s):`);
    for (const m of missing) {
        console.error(`  - ${m}`);
    }
    console.error('\nUpdate src/pi/compat.ts / feature-detect the API, or pin an older SDK version.');
    process.exit(1);
}

console.log(`Pi SDK API audit (installed version ${pkgVersion}): all required APIs present.`);
