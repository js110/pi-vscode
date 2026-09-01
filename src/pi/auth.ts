import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadPiSdk } from './compat';

let cached: ModelRuntime | undefined;

/**
 * Pi's ModelRuntime owns provider catalogs and credentials in current SDK
 * releases. Sharing one runtime keeps the sidebar aligned with the Pi CLI's
 * ~/.pi/agent authentication and model configuration.
 */
export async function getModelRuntime(): Promise<ModelRuntime> {
    if (cached) {
        return cached;
    }
    const { ModelRuntime: Runtime } = await loadPiSdk();
    cached = await Runtime.create();
    return cached;
}

export function disposeModelRuntime(): void {
    cached = undefined;
}
