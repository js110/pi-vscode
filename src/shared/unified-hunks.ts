/**
 * Parse `@@ -a,b +c,d @@` unified-diff hunks and apply a *subset* of them to
 * the original file content (per-hunk partial application). Pure string
 * logic — no vscode/fs imports so both the extension host and the webview
 * bundles can use it.
 */

export interface UnifiedHunk {
    /** `-oldStart` from the header (1-based). */
    oldStart: number;
    /** `,oldCount` (number of removed/context lines). */
    oldCount: number;
    /** Raw lines *inside* the hunk body, prefix intact (`+`, `-`, ` `, `\\`). */
    lines: string[];
}

export interface ParsedHunks {
    hunks: UnifiedHunk[];
    /** Number of hunks skipped because of malformed headers. */
    skipped: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Split a unified diff into its hunks, tolerating junk around them. */
export function parseUnifiedHunks(diffText: string): ParsedHunks {
    const hunks: UnifiedHunk[] = [];
    let skipped = 0;
    let current: UnifiedHunk | null = null;

    for (const raw of diffText.split('\n')) {
        const m = HUNK_HEADER.exec(raw);
        if (m) {
            current = {
                oldStart: parseInt(m[1], 10),
                oldCount: m[2] !== undefined && m[2] !== '' ? parseInt(m[2], 10) : 1,
                lines: [],
            };
            hunks.push(current);
            continue;
        }
        if (current) {
            if (raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' ')) {
                current.lines.push(raw);
            } else if (raw.startsWith('\\')) {
                // `\ No newline at end of file` marker — keep verbatim.
                current.lines.push(raw);
            }
            // Anything else inside a hunk (shouldn't happen) ends it defensively.
            if (!/^[+\- \\]/.test(raw) && raw.trim() !== '') {
                current = null;
                skipped++;
            }
        }
    }
    return { hunks, skipped };
}

/**
 * Rebuild the file content applying only `selected` hunks. Unselected hunks
 * leave the original lines untouched; selected hunks replace their old lines
 * with the new lines. Context lines are shared by both branches.
 *
 * `selected` is a set of indices into `hunks`.
 */
export function applyHunkSelection(
    original: string,
    hunks: UnifiedHunk[],
    selected: ReadonlySet<number>,
): string {
    const oldLen = original.endsWith('\n') ? original.length - 1 : original.length;
    const origLines = oldLen === 0 ? [] : original.slice(0, oldLen).split('\n');
    const out: string[] = [];
    let cursor = 0;

    for (let i = 0; i < hunks.length; i++) {
        const hunk = hunks[i];
        if (hunk.oldStart < 1) continue;
        const start = hunk.oldStart - 1;
        const end = Math.min(start + hunk.oldCount, origLines.length);

        out.push(...origLines.slice(cursor, start));
        cursor = end;

        if (selected.has(i)) {
            for (const line of hunk.lines) {
                if (line.startsWith('-') || line.startsWith('\\')) continue;
                out.push(line.slice(1));
            }
        } else {
            for (const line of hunk.lines) {
                if (line.startsWith('+') || line.startsWith('\\')) continue;
                out.push(line.slice(1));
            }
        }
    }

    out.push(...origLines.slice(cursor));
    return out.join('\n');
}

/** New-file variant: keep only the `+` lines of the selected hunks. */
export function applyHunkSelectionToNew(hunks: UnifiedHunk[], selected: ReadonlySet<number>): string {
    const out: string[] = [];
    for (let i = 0; i < hunks.length; i++) {
        if (!selected.has(i)) continue;
        for (const line of hunks[i].lines) {
            if (line.startsWith('+')) out.push(line.slice(1));
        }
    }
    return out.join('\n');
}