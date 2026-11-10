import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

// The vsix ships only `out/`, so every asset the bundled SDK resolves at
// *runtime* has to exist there. `PI_BUNDLED_NODE` (esbuild.js) switches the SDK
// to its compiled-binary code path, which resolves two such assets relative to
// extension.js: the codemode worker and the QuickJS wasm. Missing either one
// throws only once a user enables codemode, so guard it at build time instead.
const root = join(__dirname, '..', '..', '..');
const outDir = join(root, 'out');
const extensionJs = join(outDir, 'extension.js');
const requireFromOut = createRequire(pathToFileURL(extensionJs));

const built = existsSync(extensionJs);

describe.skipIf(!built)('packaged runtime assets', () => {
    it('defines PI_BUNDLED_NODE so the SDK uses its embedded-module loader', () => {
        const bundle = readFileSync(extensionJs, 'utf8');
        // The define is inlined as a literal, so the guard must not survive as
        // a free variable reference (that would throw a ReferenceError instead).
        expect(bundle).not.toContain('typeof PI_BUNDLED_NODE');
    });

    it('resolves the codemode worker next to extension.js', () => {
        const worker = fileURLToPath(new URL('./codemode-worker.js', pathToFileURL(extensionJs)));
        expect(existsSync(worker)).toBe(true);
        const src = readFileSync(worker, 'utf8');
        // It is spawned from a data: URL, so it must not import anything
        // relative — a relative specifier would resolve against the data: URL.
        expect(src).not.toMatch(/(?:^|\n)\s*import[^;]*from\s*["']\.\//);
    });

    it('resolves the QuickJS wasm from out/, not the excluded node_modules', () => {
        const wasm = requireFromOut.resolve('quickjs-wasi/quickjs.wasm');
        expect(wasm.startsWith(outDir)).toBe(true);
        expect(existsSync(wasm)).toBe(true);
    });

    it('keeps out/node_modules out of .vscodeignore', () => {
        const ignore = readFileSync(join(root, '.vscodeignore'), 'utf8');
        expect(ignore).toMatch(/^!out\/node_modules\/\*\*$/m);
    });
});
