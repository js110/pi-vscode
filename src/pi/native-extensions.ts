import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import type { PiSdk } from './compat';
import { hasFunction } from './compat';

/** SDK clients supply the built-in factories that the Pi CLI normally installs. */
export function nativeExtensionFactories(sdk: PiSdk): InlineExtension[] {
    return [
        ['mcp', 'createMcpExtension'],
        ['codemode', 'createCodemodeExtension'],
        ['tool-search', 'createToolSearchExtension'],
    ].flatMap(([name, method]) => hasFunction(sdk, method)
        ? [{ name, factory: (sdk as any)[method](), builtin: true, replaceable: true }]
        : []);
}
