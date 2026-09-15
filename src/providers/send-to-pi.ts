/**
 * Editor context-menu entry (PRD C7): turn the active editor selection into a
 * prompt carrying file path + line range, routed through TabManager.sendToPi
 * (prompt when idle, FollowUp queue while streaming). Pure string building —
 * no vscode imports so it stays unit-testable.
 */

import { t } from '../shared/i18n';

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

/** Closing fence must out-run any backtick run inside the code. */
function fenceFor(code: string): string {
    const runs = code.match(/^`{3,}/gm);
    const maxRun = runs ? Math.max(...runs.map((r) => r.length)) : 0;
    return '`'.repeat(Math.max(3, maxRun + 1));
}

export function buildSelectionPrompt(ctx: SelectionContext): string {
    const range = ctx.startLine === ctx.endLine
        ? `${ctx.startLine}`
        : `${ctx.startLine}-${ctx.endLine}`;
    const intro = t('sendToPi.intro', { path: ctx.displayPath, range });
    const fence = fenceFor(ctx.code);
    return `${intro}\n\n${fence}${ctx.languageId}\n${ctx.code}\n${fence}`;
}
