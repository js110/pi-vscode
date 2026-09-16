/** Diff ceiling for commit-message generation; diff structure lives in the head. */
export const COMMIT_DIFF_MAX_CHARS = 40_000;

export interface CommitDiffSource {
    diff: string;
    staged: boolean;
}

/**
 * Choose the diff a commit message should describe: staged changes when any
 * exist (they are what a commit would contain), otherwise the unstaged
 * working-tree diff. Both empty means there is nothing to commit.
 */
export function pickCommitDiffSource(staged: string, unstaged: string): CommitDiffSource | null {
    if (staged.trim()) return { diff: staged, staged: true };
    if (unstaged.trim()) return { diff: unstaged, staged: false };
    return null;
}

/** Cap oversized diffs keeping their head; file structure appears first. */
export function truncateCommitDiff(diff: string, max: number = COMMIT_DIFF_MAX_CHARS): string {
    if (diff.length <= max) return diff;
    let cut = max;
    // Don't split a UTF-16 surrogate pair at the cut point.
    const code = diff.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    const omitted = diff.length - cut;
    return `${diff.slice(0, cut)}\n[... ${omitted} characters truncated ...]`;
}

export const COMMIT_MESSAGE_SYSTEM_PROMPT = [
    'You write git commit messages.',
    'Rules:',
    '- First line: imperative mood, max 72 characters, no trailing period.',
    '- Prefix the first line with a conventional commit type (feat, fix, refactor, docs, test, chore, perf, ci) when it fits.',
    '- Optionally add one blank line, then a short body explaining WHY for non-trivial changes.',
    '- Output ONLY the commit message text: no markdown fences, no quotes, no explanations, no diff commentary.',
].join('\n');

export function buildCommitMessagePrompt(diff: string, staged: boolean): string {
    const source = staged ? 'staged' : 'unstaged';
    return [
        `Write a commit message for the following ${source} changes.`,
        '',
        'Diff:',
        diff,
    ].join('\n');
}

const FENCE_RE = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/;

/**
 * Extract the bare commit message from a model reply: strips surrounding
 * code fences, lead-in lines ("Here's the commit message:"), wrapping
 * quotes, and whitespace. Returns null when nothing usable remains.
 */
export function extractCommitMessage(text: string): string | null {
    let out = text.trim();

    const fence = out.match(FENCE_RE);
    if (fence) out = fence[2].trim();

    // A lead-in announces the message instead of being it: it ends with a
    // colon and mentions the message, while the real subject starts on a
    // later line. Only strip it when that later content actually exists —
    // a lone subject ending in a colon (e.g. "fix(config): change:") stays.
    const lines = out.split('\n');
    while (lines.length > 0) {
        const line = lines[0].trim();
        if (line === '') {
            lines.shift();
            continue;
        }
        if (
            /[:：]\s*$/.test(line)
            && /commit|message|change/i.test(line)
            && lines.slice(1).some((l) => l.trim() !== '')
        ) {
            lines.shift();
            continue;
        }
        break;
    }
    out = lines.join('\n').trim();

    out = out.replace(/^["'](.*)["']$/s, '$1').trim();
    return out.length > 0 ? out : null;
}
