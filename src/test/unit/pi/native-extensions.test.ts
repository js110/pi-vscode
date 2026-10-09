import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPiSdk } from '../../../pi/compat';
import { nativeExtensionFactories } from '../../../pi/native-extensions';

it('loads native MCP/codemode/tool-search through the real loader across reload', async () => {
    const sdk = await loadPiSdk();
    const root = await mkdtemp(join(tmpdir(), 'pi-native-extensions-'));
    try {
        const settingsManager = sdk.SettingsManager.create(root, root);
        const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
            extensionFactories: nativeExtensionFactories(sdk) });
        for (let pass = 0; pass < 2; pass++) {
            await loader.reload();
            const result = loader.getExtensions();
            expect(result.errors).toEqual([]);
            expect(result.extensions.some(extension => extension.commands.has('mcp'))).toBe(true);
            expect(result.extensions.some(extension => extension.tools.has('codemode'))).toBe(true);
            expect(result.extensions.some(extension => extension.tools.has('tool_search'))).toBe(true);
        }
        await writeFile(join(root, 'settings.json'), JSON.stringify({ extensions: ['-builtin:mcp'] }));
        await settingsManager.reload(); await loader.reload();
        expect(loader.getExtensions().extensions.some(extension => extension.commands.has('mcp'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
});
