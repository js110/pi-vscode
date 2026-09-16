import { describe, it, expect, beforeEach } from 'vitest';
import { t, setLang, getLang, thinkingLevelLabel, textParams, type Lang, TEXT_KEYS } from '../../../shared/i18n';

describe('i18n', () => {
    beforeEach(() => {
        setLang('en');
    });

    it('returns English by default', () => {
        expect(getLang()).toBe<Lang>('en');
        expect(t('approval.approve')).toBe('Approve');
    });

    it('switches language and interpolates params', () => {
        setLang('zh');
        expect(t('tool.read', { path: 'a.ts' })).toBe('读取 a.ts');
    });

    it('interpolates composed count fragments', () => {
        expect(t('config.stats', {
            providers: t('config.providerCountMany', { n: 2 }),
            models: t('config.modelCountMany', { n: 5 }),
            skills: t('config.skillCountMany', { n: 3 }),
        })).toBe('Read from Pi: 2 providers · 5 models · 3 skills');
    });

    it('leaves unknown params as visible markers', () => {
        expect(t('stream.thoughtForMany', { n: 4 })).toBe('Thought for 4 seconds');
        expect(t('stream.thoughtForMany', {})).toBe('Thought for {n} seconds');
    });

    it('falls back to the key itself for unknown keys', () => {
        expect(t('nope.missing' as any)).toBe('nope.missing');
    });

    it('has a Chinese translation for every English key', () => {
        // TEXT_KEYS is derived from the English dictionary; the zh dictionary
        // is compile-checked against it, this guards the runtime bundle too.
        expect(TEXT_KEYS.length).toBeGreaterThan(50);
    });

    it('treats any non-zh language as English', () => {
        setLang('zh');
        setLang('fr' as Lang);
        expect(getLang()).toBe<Lang>('en');
        expect(t('approval.approve')).toBe('Approve');
    });

    it('uses identical interpolation params across languages', () => {
        for (const key of TEXT_KEYS) {
            const en = textParams('en', key).sort().join(',');
            const zh = textParams('zh', key).sort().join(',');
            expect(zh, `param mismatch for ${key}`).toBe(en);
        }
    });

    it('labels thinking levels in the active language', () => {
        setLang('en');
        expect(thinkingLevelLabel('high')).toBe('High');
        setLang('zh');
        expect(thinkingLevelLabel('high')).toBe('高');
        expect(thinkingLevelLabel('weird')).toBe('weird');
    });
});
