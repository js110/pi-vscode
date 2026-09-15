/**
 * Pure helpers for incremental streaming render (PRD C4): the streaming
 * markdown is split into top-level blocks so the webview only re-renders
 * the volatile tail instead of the whole message on every delta.
 */

/**
 * Split markdown text into top-level blocks at blank lines, keeping fenced
 * code blocks (``` or ~~~, terminated or not) intact as single blocks.
 * Whitespace-only chunks are dropped.
 */
export function splitStreamBlocks(text: string): string[] {
    const blocks: string[] = [];
    let current: string[] = [];
    let fence: string | null = null; // the full opener marker run, e.g. '```' or '````'

    const flush = (): void => {
        if (current.length === 0) return;
        const joined = current.join('\n');
        if (joined.trim() !== '') blocks.push(joined);
        current = [];
    };

    for (const line of text.split('\n')) {
        if (fence !== null) {
            current.push(line);
            // CommonMark: a closer is a bare marker run of the same character,
            // at least as long as the opener, with no info string.
            const t = line.trimStart();
            const closeMatch = t.match(/^(`{3,}|~{3,})[ \t]*$/);
            if (closeMatch && closeMatch[1][0] === fence[0] && closeMatch[1].length >= fence.length) {
                fence = null;
            }
            continue;
        }
        const openMatch = line.trimStart().match(/^(`{3,}|~{3,})/);
        if (openMatch) {
            fence = openMatch[1];
            current.push(line);
            continue;
        }
        if (line.trim() === '') {
            flush();
            continue;
        }
        current.push(line);
    }
    flush();

    return blocks;
}

/** Number of leading blocks shared by both arrays (candidates to keep in the DOM). */
export function computeUnchangedPrefix(prev: string[], next: string[]): number {
    const n = Math.min(prev.length, next.length);
    let i = 0;
    while (i < n && prev[i] === next[i]) i++;
    return i;
}
