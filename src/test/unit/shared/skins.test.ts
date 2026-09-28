import { describe, it, expect } from 'vitest';
import { normalizeSkin, effectiveSkin, DEFAULT_SKIN } from '../../../shared/skins';

describe('normalizeSkin', () => {
    it('round-trips every known skin id', () => {
        for (const id of ['default', 'aurora', 'graphite', 'sunset', 'custom'] as const) {
            expect(normalizeSkin(id)).toBe(id);
        }
    });

    it('falls back to default for unknown/absent values', () => {
        expect(normalizeSkin('neon')).toBe(DEFAULT_SKIN);
        expect(normalizeSkin(undefined)).toBe(DEFAULT_SKIN);
        expect(normalizeSkin('')).toBe(DEFAULT_SKIN);
        expect(normalizeSkin(42)).toBe(DEFAULT_SKIN);
    });
});

describe('effectiveSkin', () => {
    it('keeps any configured skin as long as it is not custom', () => {
        expect(effectiveSkin('aurora', false)).toBe('aurora');
        expect(effectiveSkin('sunset', true)).toBe('sunset');
        expect(effectiveSkin('default', true)).toBe('default');
    });

    it('renders custom only when an uploaded image exists', () => {
        expect(effectiveSkin('custom', true)).toBe('custom');
        expect(effectiveSkin('custom', false)).toBe(DEFAULT_SKIN);
    });

    it('still normalizes unknown configured values', () => {
        expect(effectiveSkin('neon', true)).toBe(DEFAULT_SKIN);
    });
});