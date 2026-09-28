/**
 * Editor context-menu entry (PRD C7): turn the active editor selection into a
 * prompt carrying file path + line range, routed through TabManager.sendToPi
 * (prompt when idle, FollowUp queue while streaming). Pure string building —
 * no vscode imports so it stays unit-testable.
 */

import { t } from '../shared/i18n';
import { fenceFor } from '../shared/mention';

export const MAX_SELECTION_CHARS = 40_000;

export interface SelectionContext {
    /** Workspace-relative (or absolute) display path shown to the model. */
    displayPath: string;
    /** 1-based inclusive selection bounds. */
    startLine: number;
    endLine: number;
    languageId: string;
    code: string;
}

export function isSelectionTooLarge(code: string): boolean {
    return code.length > MAX_SELECTION_CHARS;
}

/**
 * Convert 0-based editor selection bounds to 1-based display lines. A
 * whole-lines drag ends at column 0 of the next line — zero characters of
 * that line are in the text, so it must not be claimed in the range.
 */
export function selectionLineRange(
    startLine: number,
    endLine: number,
    endCharacter: number,
): { start: number; end: number } {
    const start = startLine + 1;
    let end = endLine + 1;
    if (endCharacter === 0 && endLine > startLine) {
        end = endLine;
    }
    return { start, end };
}

export function buildSelectionPrompt(ctx: SelectionContext): string {
    const range = ctx.startLine === ctx.endLine
        ? `${ctx.startLine}`
        : `${ctx.startLine}-${ctx.endLine}`;
    const intro = t('sendToPi.intro', { path: ctx.displayPath, range });
    const fence = fenceFor(ctx.code);
    return `${intro}\n\n${fence}${ctx.languageId}\n${ctx.code}\n${fence}`;
}

export interface FileContext {
    displayPath: string;
    languageId: string;
    content: string;
}

/** Explorer multi-select entry: bundle several files into one prompt. */
export function buildFilesPrompt(files: FileContext[]): string {
    const intro = t('sendFiles.intro', { n: files.length });
    const parts = files.map((f) => {
        const fence = fenceFor(f.content);
        return `### ${f.displayPath}\n${fence}${f.languageId}\n${f.content}\n${fence}`;
    });
    return `${intro}\n\n${parts.join('\n\n')}`;
}

const EXT_LANG: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
    '.py': 'python', '.json': 'json', '.md': 'markdown', '.go': 'go',
    '.rs': 'rust', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
    '.html': 'html', '.css': 'css', '.yml': 'yaml', '.yaml': 'yaml',
    '.sh': 'bash', '.xml': 'xml', '.sql': 'sql', '.kt': 'kotlin', '.swift': 'swift',
};

/** Cheap language hint for files opened outside the editor (sends nothing
 *  heavier than a filename extension lookup through the panel). */
export function languageIdForPath(filePath: string): string {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    return EXT_LANG[ext] ?? '';
}
