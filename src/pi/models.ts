import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { ModelInfo } from '../shared/protocol';
import { loadPiSdk } from './compat';
import { getModelRuntime } from './auth';

let cached: ModelRegistry | undefined;

export async function getModelRegistry(): Promise<ModelRegistry> {
    if (cached) {
        return cached;
    }
    const { ModelRegistry: MR } = await loadPiSdk();
    cached = new MR(await getModelRuntime());
    return cached;
}

export function getAvailableModels(registry: ModelRegistry): ModelInfo[] {
    return registry.getAvailable().map((m) => ({
        provider: String(m.provider),
        id: m.id,
        name: m.name,
    }));
}

export function findModel(
    registry: ModelRegistry,
    provider: string,
    modelId: string,
): ReturnType<ModelRegistry['find']> {
    return registry.find(provider, modelId);
}

export function disposeModelRegistry() {
    cached = undefined;
}
