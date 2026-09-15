/**
 * Inline chat (PRD C13): parse a unified diff (as produced by
 * computeUnifiedDiff) into changed-line ranges in the NEW file, for editor
 * decoration previews. Pure string handling — no vscode imports.
 */

export interface InlineChangeRange {
    /** 0-based inclusive first changed line in the new file. */
    start: number;
    /** 0-based inclusive last changed line in the new file. */
    end: number;
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseChangedLineRanges(diffText: string): InlineChangeRange[] {
    if (!diffText) return [];

    const ranges: InlineChangeRange[] = [];
    let newLine = 0;
    let current: InlineChangeRange | null = null;
    let sawHunk = false;

    const flush = (): void => {
        if (current) {
            ranges.push(current);
            current = null;
        }
    };

    for (const raw of diffText.split('\n')) {
        const hunk = HUNK_RE.exec(raw);
        if (hunk) {
            flush();
            sawHunk = true;
            newLine = parseInt(hunk[1], 10);
            continue;
        }
        // File headers ("--- a/x", "+++ b/x") carry no line position — but
        // only before the first hunk; an added line whose content starts
        // with "++" must not be mistaken for one.
        if (!sawHunk && (raw.startsWith('---') || raw.startsWith('+++'))) continue;
        if (raw.startsWith('+')) {
            const line0 = newLine - 1;
            if (current && current.end + 1 >= line0) {
                current.end = line0;
            } else {
                flush();
                current = { start: line0, end: line0 };
            }
            newLine++;
        } else if (raw.startsWith(' ')) {
            newLine++;
        }
        // '-' lines exist only in the old file — no new-file position.
    }
    flush();
    return ranges;
}
