import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        // Pin the download so repeated runs reuse one .vscode-test install
        // instead of fetching a fresh stable build every time. Must satisfy
        // engines.vscode (^1.100.0) in package.json.
        version: '1.100.0',
        launchArgs: ['--disable-extensions'],
    });
}

main().catch((err) => {
    console.error('Failed to run tests:', err);
    process.exit(1);
});
