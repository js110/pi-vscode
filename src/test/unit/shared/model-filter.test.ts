import { describe, it, expect } from 'vitest';
import { matchesModelFilter } from '../../../shared/model-filter';

describe('matchesModelFilter', () => {
    it('matches case-insensitively', () => {
        expect(matchesModelFilter('DeepSeek V4 Pro', 'deepseek')).toBe(true);
        expect(matchesModelFilter('deepseek-chat', 'SEEK-CHAT')).toBe(true);
    });

    it('rejects non-matching names', () => {
        expect(matchesModelFilter('gpt-5', 'claude')).toBe(false);
    });

    it('matches everything on an empty query', () => {
        expect(matchesModelFilter('anything', '')).toBe(true);
        expect(matchesModelFilter('anything', '   ')).toBe(true);
    });

    it('treats a missing name as no match while a query is present', () => {
        expect(matchesModelFilter(undefined, 'x')).toBe(false);
    });

    it('filters 120 models well under 100ms per query (AC-FN-18)', () => {
        const names = Array.from({ length: 120 }, (_, i) => `provider-${i % 6}/model-${i}-variant`);
        const queries = ['model-1', 'variant', 'provider-3', 'zzz-none'];
        const start = performance.now();
        let hits = 0;
        for (let round = 0; round < 20; round++) {
            for (const q of queries) {
                for (const name of names) {
                    if (matchesModelFilter(name, q)) hits++;
                }
            }
        }
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(100);
        expect(hits).toBeGreaterThan(0);
    });
});
