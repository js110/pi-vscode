import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { ModelInfo } from '../shared/protocol';
import { modelSupportsImages } from '../shared/image-input';
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
        supportsImages: modelSupportsImages(m as { input?: unknown }),
    }));
}

export function findModel(
    registry: ModelRegistry,
    provider: string,
    modelId: string,
): ReturnType<ModelRegistry['find']> {
    return registry.find(provider, modelId);
}

/**
 * Resolve the VS Code-side default model (pi-agent.defaultModel/apiProvider)
 * the same way new sessions do: search *available* models (credentials
 * verified) and treat an empty provider as "any provider".
 */
export function findConfiguredModel(
    registry: ModelRegistry,
    provider: string,
    modelId: string,
): ReturnType<ModelRegistry['find']> {
    if (!modelId) return undefined;
    const match = getAvailableModels(registry).find(
        (m) => m.id === modelId && (!provider || m.provider === provider),
    );
    if (!match) return undefined;
    return findModel(registry, match.provider, match.id);
}

export function disposeModelRegistry() {
    cached = undefined;
}
