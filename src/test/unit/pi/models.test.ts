import { describe, it, expect } from 'vitest';
import { getModelRegistry, TEST_MODEL_PROVIDER, TEST_MODEL_ID } from '../../setup';
import { findConfiguredModel } from '../../../pi/models';

describe('Model Registry', () => {
    it('lists available models', () => {
        const registry = getModelRegistry();
        const models = registry.getAvailable();
        expect(models.length).toBeGreaterThan(0);
    });

    it('finds the test model', () => {
        const registry = getModelRegistry();
        const model = registry.find(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
        expect(model).toBeDefined();
        expect(model!.id).toBe(TEST_MODEL_ID);
    });

    it('model has expected properties', () => {
        const registry = getModelRegistry();
        const model = registry.find(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
        expect(model).toBeDefined();
        expect(model!.provider).toBe(TEST_MODEL_PROVIDER);
        expect(typeof model!.id).toBe('string');
    });

    it('returns undefined for nonexistent model', () => {
        const registry = getModelRegistry();
        const model = registry.find('nonexistent', 'nonexistent');
        expect(model).toBeUndefined();
    });

    it('findConfiguredModel resolves an available model id with any provider', () => {
        const registry = getModelRegistry();
        const model = findConfiguredModel(registry, '', TEST_MODEL_ID);
        expect(model).toBeDefined();
        expect(model!.id).toBe(TEST_MODEL_ID);
    });

    it('findConfiguredModel respects the provider filter', () => {
        const registry = getModelRegistry();
        expect(findConfiguredModel(registry, TEST_MODEL_PROVIDER, TEST_MODEL_ID)).toBeDefined();
        expect(findConfiguredModel(registry, 'no-such-provider', TEST_MODEL_ID)).toBeUndefined();
    });

    it('findConfiguredModel returns undefined without a model id', () => {
        const registry = getModelRegistry();
        expect(findConfiguredModel(registry, TEST_MODEL_PROVIDER, '')).toBeUndefined();
    });
});
