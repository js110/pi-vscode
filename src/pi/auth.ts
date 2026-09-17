import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadPiSdk } from './compat';

let cachedPromise: Promise<ModelRuntime> | undefined;

/**
 * Pi's ModelRuntime owns provider catalogs and credentials in current SDK
 * releases. Sharing one runtime keeps the sidebar aligned with the Pi CLI's
 * ~/.pi/agent authentication and model configuration.
 */
export async function getModelRuntime(): Promise<ModelRuntime> {
    cachedPromise ??= (async () => {
        const { ModelRuntime: Runtime } = await loadPiSdk();
        return Runtime.create();
    })();
    return cachedPromise;
}

export function disposeModelRuntime(): void {
    cachedPromise = undefined;
}
