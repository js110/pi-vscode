import { describe, it, expect } from 'vitest';
import {
    pickCommitDiffSource,
    truncateCommitDiff,
    buildCommitMessagePrompt,
    extractCommitMessage,
    COMMIT_DIFF_MAX_CHARS,
    COMMIT_MESSAGE_SYSTEM_PROMPT,
} from '../../../shared/commit-message';

describe('pickCommitDiffSource', () => {
    it('prefers the staged diff when present', () => {
        const src = pickCommitDiffSource('diff --git staged', 'diff --git unstaged');
        expect(src).toEqual({ diff: 'diff --git staged', staged: true });
    });

    it('falls back to the unstaged diff when nothing is staged', () => {
        const src = pickCommitDiffSource('', 'diff --git unstaged');
        expect(src).toEqual({ diff: 'diff --git unstaged', staged: false });
    });

    it('treats whitespace-only diffs as empty', () => {
        expect(pickCommitDiffSource('  \n\t', 'diff --git unstaged')).toEqual({
            diff: 'diff --git unstaged',
            staged: false,
        });
        expect(pickCommitDiffSource('  \n\t', '')).toBeNull();
    });

    it('returns null when there are no changes at all', () => {
        expect(pickCommitDiffSource('', '')).toBeNull();
    });
});

describe('truncateCommitDiff', () => {
    it('keeps short diffs unchanged', () => {
        expect(truncateCommitDiff('short diff', 100)).toBe('short diff');
    });

    it('keeps the head of an oversized diff with an explicit marker', () => {
        const diff = 'head-'.repeat(30) + 'tail';
        const out = truncateCommitDiff(diff, 100);
        expect(out.startsWith(diff.slice(0, 100))).toBe(true);
        expect(out).toContain('truncated');
        expect(out.endsWith('tail')).toBe(false);
    });

    it('exposes the production cap as a sane constant', () => {
        expect(COMMIT_DIFF_MAX_CHARS).toBe(40_000);
    });

    it('does not split a UTF-16 surrogate pair at the cut', () => {
        const diff = 'a'.repeat(98) + '😀' + 'b'.repeat(10);
        const out = truncateCommitDiff(diff, 100);
        expect(out.startsWith('a'.repeat(98) + '😀')).toBe(true);
        expect(out).toContain('truncated');
    });
});

describe('buildCommitMessagePrompt', () => {
    it('embeds the diff and states its source', () => {
        const prompt = buildCommitMessagePrompt('diff --git a/x b/x', true);
        expect(prompt).toContain('staged');
        expect(prompt).toContain('diff --git a/x b/x');
    });

    it('labels unstaged diffs as such', () => {
        const prompt = buildCommitMessagePrompt('diff', false);
        expect(prompt).toContain('unstaged');
        expect(prompt).not.toContain('staged\n');
    });

    it('asks for a bare conventional message with a bounded subject', () => {
        expect(COMMIT_MESSAGE_SYSTEM_PROMPT).toContain('72');
        expect(COMMIT_MESSAGE_SYSTEM_PROMPT).toMatch(/feat|fix|conventional/i);
        expect(COMMIT_MESSAGE_SYSTEM_PROMPT.toLowerCase()).toContain('only');
    });
});

describe('extractCommitMessage', () => {
    it('returns a plain single-line message unchanged', () => {
        expect(extractCommitMessage('feat: add login flow')).toBe('feat: add login flow');
    });

    it('keeps a multi-line message with body', () => {
        const text = 'feat: add login flow\n\nTokens are refreshed lazily to avoid\na redirect loop on expired sessions.';
        expect(extractCommitMessage(text)).toBe(text);
    });

    it('strips a surrounding code fence', () => {
        expect(extractCommitMessage('```\nfix: guard empty input\n```')).toBe('fix: guard empty input');
        expect(extractCommitMessage('````text\nfix: guard empty input\n````')).toBe('fix: guard empty input');
    });

    it('drops a lead-in line before the message', () => {
        expect(extractCommitMessage("Here's the commit message:\n\nfix: guard empty input"))
            .toBe('fix: guard empty input');
        expect(extractCommitMessage('Commit message:\nfix: guard empty input'))
            .toBe('fix: guard empty input');
    });

    it('unwraps surrounding quotes', () => {
        expect(extractCommitMessage('"fix: guard empty input"')).toBe('fix: guard empty input');
    });

    it('trims surrounding whitespace', () => {
        expect(extractCommitMessage('\n  fix: guard empty input  \n')).toBe('fix: guard empty input');
    });

    it('returns null for empty or fence-only output', () => {
        expect(extractCommitMessage('')).toBeNull();
        expect(extractCommitMessage('   \n\t ')).toBeNull();
        expect(extractCommitMessage('```\n```')).toBeNull();
    });

    it('does not mistake a conventional subject for a lead-in', () => {
        // A subject line containing "message" must survive ("message: ..." colon form)
        expect(extractCommitMessage('fix: correct commit message truncation'))
            .toBe('fix: correct commit message truncation');
    });

    it('keeps a lone colon subject that merely mentions a change', () => {
        // No content after it — stripping would leave nothing.
        expect(extractCommitMessage('fix(config): change:')).toBe('fix(config): change:');
    });
});
