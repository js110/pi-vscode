/**
 * Pure LCS-based line diff used by the Apply preview (PRD C3).
 * Output lines are prefixed with '+', '-', or ' ' so they can be fed
 * directly into renderDiffLines() in webview-text.ts.
 */
export interface LineDiffResult {
    diff: string;
    added: number;
    removed: number;
}

/** Above this many LCS cells (old lines × new lines), fall back to a whole-block diff. */
export const MAX_DIFF_CELLS = 1_000_000;

function splitLines(text: string): string[] {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

export function computeLineDiff(oldText: string, newText: string): LineDiffResult {
    const a = splitLines(oldText);
    const b = splitLines(newText);

    if (oldText === newText) {
        return { diff: '', added: 0, removed: 0 };
    }

    // LCS table (DP). Cap the cell count so a pathological target (huge file)
    // degrades to a coarse whole-block replacement instead of ballooning memory.
    if (a.length * b.length > MAX_DIFF_CELLS) {
        return {
            diff: [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join('\n'),
            added: b.length,
            removed: a.length,
        };
    }

    // Snippets are small; O(n*m) is fine here.
    const n = a.length;
    const m = b.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }

    const out: string[] = [];
    let added = 0;
    let removed = 0;
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push(` ${a[i]}`);
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            out.push(`-${a[i]}`);
            removed++;
            i++;
        } else {
            out.push(`+${b[j]}`);
            added++;
            j++;
        }
    }
    while (i < n) {
        out.push(`-${a[i]}`);
        removed++;
        i++;
    }
    while (j < m) {
        out.push(`+${b[j]}`);
        added++;
        j++;
    }

    return { diff: added === 0 && removed === 0 ? '' : out.join('\n'), added, removed };
}
