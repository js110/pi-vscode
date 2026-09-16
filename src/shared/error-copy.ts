/**
 * Humanized error copy (T17 / PRD 13.4): raw SDK/API errors never reach the
 * user as-is. classifyError maps an unknown error onto a small set of
 * user-meaningful categories by message/name/code features; the copy for
 * each category states what happened, the impact, and a suggested action.
 * Aborts are the user's own action and stay silent.
 */

import { t, type TextKey } from './i18n';

export type ErrorKind = 'auth' | 'network' | 'rateLimit' | 'aborted' | 'config' | 'unknown';

function messageOf(err: unknown): string {
    if (typeof err === 'string') return err;
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    if (err && typeof err === 'object') {
        const anyErr = err as { name?: unknown; code?: unknown; message?: unknown };
        return [anyErr.name, anyErr.code, anyErr.message]
            .filter((part): part is string => typeof part === 'string')
            .join(' ');
    }
    return String(err);
}

const PATTERNS: readonly [ErrorKind, RegExp][] = [
    // Word-bounded: server-side cancellations ("CANCELLED", "stream
    // cancelled after error") must NOT look like user aborts, or every
    // application point would swallow them silently.
    ['aborted', /\b(abort\w*|interrupted?)\b/i],
    ['auth', /\b40[13]\b|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|api[ _-]?key|credential|authenticat/i],
    ['rateLimit', /\b429\b|rate[ _-]?limit|too many requests|quota/i],
    ['network', /network|fetch[ _-]?failed|econn|enotfound|etimedout|eai_again|timed?[ _-]?out|socket|dns|proxy|offline/i],
    ['config', /config|no such|enoent|missing/i],
];

export function classifyError(err: unknown): ErrorKind {
    if (err instanceof Error && err.name === 'AbortError') return 'aborted';
    const message = messageOf(err);
    for (const [kind, pattern] of PATTERNS) {
        if (pattern.test(message)) return kind;
    }
    return 'unknown';
}

/** Human copy for `err`, or undefined for aborts (user-initiated, silent). */
export function humanizeErrorMessage(err: unknown): string | undefined {
    const kind = classifyError(err);
    if (kind === 'aborted') return undefined;
    if (kind === 'unknown') {
        return t('err.unknown', { message: messageOf(err) });
    }
    return t(`err.${kind}` as TextKey);
}
