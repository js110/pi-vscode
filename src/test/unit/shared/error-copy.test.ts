import { describe, it, expect, beforeEach } from 'vitest';
import { classifyError, humanizeErrorMessage } from '../../../shared/error-copy';
import { setLang } from '../../../shared/i18n';

describe('classifyError', () => {
    it('detects auth failures', () => {
        expect(classifyError(new Error('Request failed with status 401'))).toBe('auth');
        expect(classifyError(new Error('invalid API key provided'))).toBe('auth');
        expect(classifyError(new Error('Unauthorized'))).toBe('auth');
    });

    it('detects network failures', () => {
        expect(classifyError(new Error('fetch failed'))).toBe('network');
        expect(classifyError(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe('network');
        expect(classifyError(new Error('request timed out'))).toBe('network');
    });

    it('detects rate limits', () => {
        expect(classifyError(new Error('429 Too Many Requests'))).toBe('rateLimit');
        expect(classifyError(new Error('rate limit exceeded'))).toBe('rateLimit');
    });

    it('detects aborts by name and message', () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        expect(classifyError(err)).toBe('aborted');
        expect(classifyError(new Error('Request aborted'))).toBe('aborted');
        expect(classifyError(new Error('Turn interrupted'))).toBe('aborted');
    });

    it('does not mistake server-side cancellation for a user abort', () => {
        // These must surface as errors, never silently swallow (T17 review).
        expect(classifyError(new Error('stream cancelled after error'))).not.toBe('aborted');
        expect(classifyError(new Error('request CANCELLED by server'))).not.toBe('aborted');
    });

    it('detects config problems', () => {
        expect(classifyError(new Error('Pi config not found'))).toBe('config');
        expect(classifyError(new Error('ENOENT: no such file'))).toBe('config');
    });

    it('does not mistake filesystem permission errors for auth', () => {
        expect(classifyError(new Error('EACCES: permission denied, open ~/.pi/config.json'))).not.toBe('auth');
    });

    it('falls back to unknown', () => {
        expect(classifyError(new Error('something exploded'))).toBe('unknown');
        expect(classifyError(undefined)).toBe('unknown');
    });
});

describe('humanizeErrorMessage', () => {
    beforeEach(() => setLang('en'));

    it('stays silent for aborts', () => {
        expect(humanizeErrorMessage(new Error('Request aborted'))).toBeUndefined();
    });

    it('returns category copy stating impact and action', () => {
        const text = humanizeErrorMessage(new Error('401 Unauthorized'))!;
        expect(text).toMatch(/api key|login/i);
    });

    it('appends the raw detail only for unknown errors', () => {
        expect(humanizeErrorMessage(new Error('something exploded'))).toContain('something exploded');
        const auth = humanizeErrorMessage(new Error('invalid api key'))!;
        expect(auth).not.toContain('invalid api key');
    });

    it('translates to Chinese', () => {
        setLang('zh');
        expect(humanizeErrorMessage(new Error('fetch failed'))).toContain('网络');
    });

    it('accepts plain strings and non-Error objects', () => {
        expect(humanizeErrorMessage('rate limit exceeded')).toBeDefined();
        expect(humanizeErrorMessage({ code: 'ECONNREFUSED' })).toBeDefined();
    });
});
