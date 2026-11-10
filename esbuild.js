const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');

const importMetaPlugin = {
    name: 'import-meta-shim',
    setup(build) {
        build.onLoad({ filter: /node_modules[\\/]@earendil-works[\\/].*\.js$/ }, async (args) => {
            let contents = await fs.promises.readFile(args.path, 'utf8');
            if (!contents.includes('import.meta')) return;
            contents = contents.replace(
                /\bimport\.meta\.resolve\b/g,
                '((_spec) => globalThis.__piBundle.pathToFileURL(require.resolve(_spec)).href)',
            );
            contents = contents.replace(
                /\bimport\.meta\.url\b/g,
                'globalThis.__piBundle.url',
            );
            return { contents, loader: 'js' };
        });
    },
};

const extensionConfig = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    sourcemap: isWatch,
    minify: !isWatch,
    // The Pi SDK is bundled into extension.js and the vsix ships no
    // node_modules, so the SDK's "unbundled" loader path is unusable: it builds
    // jiti aliases with require.resolve from a dist/ that no longer exists.
    // Native Pi extensions (the IDE bridge) then fail to load silently and
    // their tools disappear. Defining this flag switches the SDK to its
    // compiled-binary path, whose extra runtime assets are copied by
    // copyCodemodeWorker() below.
    define: { PI_BUNDLED_NODE: 'true' },
    plugins: [importMetaPlugin],
    banner: {
        js: [
            'globalThis.__piBundle = (function() {',
            '  var u = require("url");',
            '  var meta = u.pathToFileURL(__filename).href;',
            '  return { url: meta, pathToFileURL: u.pathToFileURL };',
            '})();',
        ].join('\n'),
    },
};

const webviewConfig = {
    entryPoints: ['src/webview/main.ts'],
    bundle: true,
    outdir: 'out/webview',
    entryNames: '[name]',
    chunkNames: '[name]-[hash]',
    format: 'esm',
    splitting: true,
    platform: 'browser',
    target: 'es2022',
    sourcemap: isWatch,
    minify: !isWatch,
};

const settingsWebviewConfig = {
    entryPoints: ['src/webview/settings.ts'],
    bundle: true,
    outfile: 'out/webview/settings.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: isWatch,
    minify: !isWatch,
};

// Hash-named webview chunks accumulate across builds because esbuild names them
// content-hash only. Wipe the whole directory (including the stale legacy
// `frame/` dir, whose source no longer exists) so a build — and especially a
// packaged vsix — can never ship unreachable chunks. Only out/webview is
// cleared: out/extension.js must survive watch restarts so F5 keeps working.
async function cleanWebview() {
    await fs.promises.rm(path.join('out', 'webview'), { recursive: true, force: true });
}

// PI_BUNDLED_NODE makes the SDK resolve its codemode worker as
// `new URL("./codemode-worker.js", <extension.js url>)`, so the worker has to
// sit next to out/extension.js. The SDK ships it as a self-contained chunk
// (no relative imports, no import.meta) precisely so a release build can copy
// it verbatim; without it codemode throws ENOENT on first use.
async function copyCodemodeWorker() {
    const src = path.join(
        'node_modules', '@earendil-works', 'pi-coding-agent',
        'dist', 'bundle', 'chunks', 'codemode-worker.js',
    );
    if (!fs.existsSync(src)) return;
    await fs.promises.copyFile(src, path.join('out', 'codemode-worker.js'));

    // The worker's QuickJS VM is located with
    // createRequire(<extension.js>).resolve("quickjs-wasi/quickjs.wasm").
    // node_modules is excluded from the vsix, so mirror just that one package
    // under out/ — otherwise enabling codemode throws MODULE_NOT_FOUND.
    const wasmSrc = path.join('node_modules', 'quickjs-wasi', 'quickjs.wasm');
    if (!fs.existsSync(wasmSrc)) return;
    const wasmDir = path.join('out', 'node_modules', 'quickjs-wasi');
    await fs.promises.mkdir(wasmDir, { recursive: true });
    await fs.promises.copyFile(wasmSrc, path.join(wasmDir, 'quickjs.wasm'));
    await fs.promises.writeFile(
        path.join(wasmDir, 'package.json'),
        JSON.stringify({ name: 'quickjs-wasi', version: '0.0.0', exports: { './quickjs.wasm': './quickjs.wasm' } }),
    );
}

async function copyStyles() {
    const stylesDir = path.join('out', 'webview', 'styles');
    await fs.promises.mkdir(stylesDir, { recursive: true });
    const srcDir = path.join('src', 'webview', 'styles');
    for (const file of await fs.promises.readdir(srcDir)) {
        await fs.promises.copyFile(path.join(srcDir, file), path.join(stylesDir, file));
    }
    // Codicon font + glyph classes ship next to the webview bundles; the
    // stylesheet's relative url("codicon.ttf") resolves against this copy.
    const codiconSrc = path.join('node_modules', '@vscode', 'codicons', 'dist');
    for (const file of ['codicon.css', 'codicon.ttf']) {
        await fs.promises.copyFile(path.join(codiconSrc, file), path.join('out', 'webview', file));
    }
    // KaTeX stylesheet + fonts (woff2 only: the webview is Chromium, and the
    // CSS picks the first format it supports). Same relative-url rule as codicon.
    const katexSrc = path.join('node_modules', 'katex', 'dist');
    await fs.promises.copyFile(path.join(katexSrc, 'katex.min.css'), path.join('out', 'webview', 'katex.min.css'));
    const katexFontsDir = path.join('out', 'webview', 'fonts');
    await fs.promises.mkdir(katexFontsDir, { recursive: true });
    for (const file of await fs.promises.readdir(path.join(katexSrc, 'fonts'))) {
        if (file.endsWith('.woff2')) {
            await fs.promises.copyFile(path.join(katexSrc, 'fonts', file), path.join(katexFontsDir, file));
        }
    }
}

async function build() {
    await cleanWebview();
    if (isWatch) {
        const extCtx = await esbuild.context(extensionConfig);
        const webCtx = await esbuild.context(webviewConfig);
        const settingsCtx = await esbuild.context(settingsWebviewConfig);
        await Promise.all([extCtx.watch(), webCtx.watch(), settingsCtx.watch()]);
        await copyStyles();
        await copyCodemodeWorker();
        console.log('Watching for changes...');
    } else {
        await esbuild.build(extensionConfig);
        await esbuild.build(webviewConfig);
        await esbuild.build(settingsWebviewConfig);
        await copyStyles();
        await copyCodemodeWorker();
        console.log('Build complete.');
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
