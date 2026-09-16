import { describe, it, expect } from 'vitest';
import { TtlCache } from '../../../shared/ttl-cache';

describe('TtlCache', () => {
    it('returns a stored value while fresh', () => {
        let now = 1_000;
        const cache = new TtlCache<string>(5_000, { now: () => now });
        cache.set('k', 'v');
        expect(cache.get('k')).toBe('v');
    });

    it('expires after the ttl', () => {
        let now = 1_000;
        const cache = new TtlCache<string>(5_000, { now: () => now });
        cache.set('k', 'v');
        now += 5_001;
        expect(cache.get('k')).toBeUndefined();
    });

    it('is still fresh exactly at the ttl boundary', () => {
        let now = 1_000;
        const cache = new TtlCache<string>(5_000, { now: () => now });
        cache.set('k', 'v');
        now += 5_000;
        expect(cache.get('k')).toBe('v');
    });

    it('invalidates explicitly regardless of ttl', () => {
        const cache = new TtlCache<string>(60_000);
        cache.set('k', 'v');
        cache.invalidate();
        expect(cache.get('k')).toBeUndefined();
    });

    it('distinguishes keys', () => {
        const cache = new TtlCache<string>(60_000);
        cache.set('a', 'va');
        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('a')).toBe('va');
    });

    it('re-stores after expiry', () => {
        let now = 1_000;
        const cache = new TtlCache<string>(5_000, { now: () => now });
        cache.set('k', 'old');
        now += 6_000;
        expect(cache.get('k')).toBeUndefined();
        cache.set('k', 'new');
        expect(cache.get('k')).toBe('new');
    });

    it('uses wall time when no now is injected', () => {
        const cache = new TtlCache<string>(60_000);
        cache.set('k', 'v');
        expect(cache.get('k')).toBe('v');
    });
});
