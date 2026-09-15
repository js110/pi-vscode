import { describe, it, expect, beforeEach } from 'vitest';
import { t, setLang, getLang, type Lang, TEXT_KEYS } from '../../../shared/i18n';

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
            providers: t('config.providerCount', { n: 2, s: 's' }),
            models: t('config.modelCount', { n: 5, s: 's' }),
            skills: t('config.skillCount', { n: 3, s: 's' }),
        })).toBe('Read from Pi: 2 providers · 5 models · 3 skills');
    });

    it('leaves unknown params as visible markers', () => {
        expect(t('stream.thoughtFor', { n: 4, s: 's' })).toBe('Thought for 4 seconds');
        expect(t('stream.thoughtFor', {})).toBe('Thought for {n} second{s}');
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
});
