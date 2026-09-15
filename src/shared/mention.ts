/**
 * @-mention (PRD C7 / AC-FN-21~23): the webview inserts `@path` or
 * `@path:line` tokens from the completion popup; the host validates them at
 * send time, strips refs whose file no longer exists, and appends the
 * referenced content to the prompt so it reaches the model. Pure string and
 * ranking logic lives here so it stays unit-testable.
 */

export const MAX_MENTION_RESULTS = 20;
export const MAX_MENTION_FILE_CHARS = 50_000;
/** Lines provided around a `@path:line` symbol reference. */
export const MENTION_CONTEXT_WINDOW_LINES = 60;

export interface MentionRef {
    path: string;
    line?: number;
}

/** Parse an `@`-token body: relative posix path, optional 1-based line. */
export function parseMentionToken(token: string): MentionRef | null {
    const normalized = token.replace(/\\/g, '/');
    const match = /^([^:]+?)(?::(\d+))?$/.exec(normalized);
    if (!match) return null;
    const path = match[1];
    if (!path || path.startsWith('/') || path.split('/').includes('..')) return null;
    const line = match[2] !== undefined ? Number(match[2]) : undefined;
    if (line !== undefined && (!Number.isInteger(line) || line < 1)) return null;
    return { path, line };
}

/** Positive subsequence score; 0 = no match. Higher is better. */
function fuzzyScore(text: string, query: string): number {
    let from = 0;
    let score = 1;
    let streak = 0;
    for (const ch of query) {
        const idx = text.indexOf(ch, from);
        if (idx < 0) return 0;
        if (idx === from) {
            streak++;
            score += 2 + streak;
        } else {
            streak = 0;
            score += 1;
        }
        if (idx === 0 || '/_-.'.includes(text[idx - 1])) score += 2;
        from = idx + 1;
    }
    return score;
}

/** Rank paths by fuzzy subsequence match against the query, best first. */
export function fuzzyFilterFiles(paths: string[], query: string, limit: number): string[] {
    const q = query.toLowerCase();
    if (!q) return paths.slice(0, limit);
    const scored: { path: string; score: number }[] = [];
    for (const path of paths) {
        const score = fuzzyScore(path.toLowerCase(), q);
        if (score > 0) scored.push({ path, score });
    }
    scored.sort(
        (a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
    );
    return scored.slice(0, limit).map((s) => s.path);
}

/** Whether the draft still contains `@token` as a whole reference
 *  (must not match inside `@token:42`, which is a distinct symbol ref). */
export function hasMentionToken(text: string, token: string): boolean {
    return new RegExp(`@${escapeRegExp(token)}(?=\\s|$)`).test(text);
}

/** Remove invalid `@token` refs (whole-token matches only) from the message. */
export function stripMentions(text: string, tokens: string[]): string {
    if (tokens.length === 0) return text;
    let out = text;
    for (const token of tokens) {
        out = out.replace(new RegExp(`( ?)@${escapeRegExp(token)}(?=\\s|$)`, 'g'), '');
    }
    return out.trim();
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Language hint for the fenced block: the file extension, or none. */
function langFromPath(path: string): string {
    const dot = path.lastIndexOf('.');
    const slash = path.lastIndexOf('/');
    return dot > slash ? path.slice(dot + 1).toLowerCase() : '';
}

export interface MentionContextEntry {
    token: string;
    ref: MentionRef;
    content: string;
}

/** Closing fence must out-run any backtick run inside the content. */
export function fenceFor(content: string): string {
    const runs = content.match(/^`{3,}/gm);
    const maxRun = runs ? Math.max(...runs.map((r) => r.length)) : 0;
    return '`'.repeat(Math.max(3, maxRun + 1));
}

/** Build the context appendix appended to the prompt for valid refs. */
export function buildMentionContext(entries: MentionContextEntry[]): string {
    return entries
        .map((e) => {
            const fence = fenceFor(e.content);
            return `\n\n@${e.token}:\n${fence}${langFromPath(e.ref.path)}\n${e.content.trimEnd()}\n${fence}`;
        })
        .join('');
}

/** Cap oversized file content with an explicit truncation note. */
export function truncateMentionContent(content: string, max: number): string {
    if (content.length <= max) return content;
    return `${content.slice(0, max)}\n[truncated]`;
}

/** Slice `window` lines out of a file body around the 1-based line. */
export function extractLines(content: string, line: number, window: number): string {
    const lines = content.split('\n');
    const before = Math.floor(window / 5);
    const start = Math.min(
        Math.max(0, line - 1 - before),
        Math.max(0, lines.length - 1),
    );
    const end = Math.min(lines.length, start + window);
    return lines.slice(start, end).join('\n');
}
