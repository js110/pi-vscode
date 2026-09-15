import { describe, it, expect } from 'vitest';
import {
    buildSelectionPrompt,
    isSelectionTooLarge,
    selectionLineRange,
    MAX_SELECTION_CHARS,
} from '../../../providers/send-to-pi';

describe('buildSelectionPrompt', () => {
    it('includes path, line range, and a fenced code block', () => {
        const text = buildSelectionPrompt({
            displayPath: 'src/a.ts',
            startLine: 10,
            endLine: 12,
            languageId: 'typescript',
            code: 'const a = 1;\nconst b = 2;\nconst c = 3;',
        });

        expect(text).toContain('src/a.ts');
        expect(text).toContain('10-12');
        expect(text).toContain('```typescript\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```');
    });

    it('uses the single line number for a one-line selection', () => {
        const text = buildSelectionPrompt({
            displayPath: 'src/a.ts',
            startLine: 7,
            endLine: 7,
            languageId: 'python',
            code: 'x = 1',
        });

        expect(text).toContain('7');
        expect(text).not.toContain('7-7');
    });

    it('falls back to a bare fence when the language id is empty', () => {
        const text = buildSelectionPrompt({
            displayPath: 'notes.txt',
            startLine: 1,
            endLine: 2,
            languageId: '',
            code: 'hello\nworld',
        });

        expect(text).toContain('```\nhello\nworld\n```');
    });

    it('does not swallow leading whitespace in the code', () => {
        const text = buildSelectionPrompt({
            displayPath: 'a.py',
            startLine: 3,
            endLine: 4,
            languageId: 'python',
            code: '  if x:\n    pass',
        });

        expect(text).toContain('```python\n  if x:\n    pass\n```');
    });

    it('lengthens the fence when the code contains triple backticks', () => {
        const text = buildSelectionPrompt({
            displayPath: 'README.md',
            startLine: 1,
            endLine: 3,
            languageId: 'markdown',
            code: '```js\nvar x = 1\n```',
        });

        expect(text).toContain('````markdown\n```js\nvar x = 1\n```\n````');
    });
});

describe('selectionLineRange', () => {
    it('converts 0-based editor lines to 1-based display lines', () => {
        expect(selectionLineRange(9, 11, 5)).toEqual({ start: 10, end: 12 });
    });

    it('drops the end line when the selection ends at its column 0', () => {
        expect(selectionLineRange(9, 11, 0)).toEqual({ start: 10, end: 11 });
    });

    it('keeps a single-line selection intact', () => {
        expect(selectionLineRange(6, 6, 4)).toEqual({ start: 7, end: 7 });
    });
});

describe('isSelectionTooLarge', () => {
    it('is false within the cap and true beyond it', () => {
        expect(isSelectionTooLarge('x'.repeat(MAX_SELECTION_CHARS))).toBe(false);
        expect(isSelectionTooLarge('x'.repeat(MAX_SELECTION_CHARS + 1))).toBe(true);
    });
});
