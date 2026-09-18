/**
 * Non-image file attachments: text files picked or dragged into the composer
 * are read as text in the webview and appended to the prompt as fenced context
 * blocks (so the model always sees their content). Pure helpers live here —
 * webview reads/normalizes, host builds the appendix.
 */

import { MAX_MENTION_FILE_CHARS } from './mention';
import { fenceFor, langFromPath } from './mention';

/** Pre-read size cap per attached file (decoded memory budget in the webview). */
export const MAX_ATTACH_FILE_BYTES = 5 * 1024 * 1024;

/** Inline content cap per attached file, matching @-mention files. */
export const MAX_ATTACH_CHARS = MAX_MENTION_FILE_CHARS;

export interface AttachFileEntry {
    name: string;
    content: string;
}

/** Binary sniff: a NUL byte in the first 8 KiB almost certainly means binary. */
export function looksBinary(prefix: ArrayBuffer | Uint8Array): boolean {
    const bytes = prefix instanceof Uint8Array ? prefix : new Uint8Array(prefix);
    for (let i = 0; i < Math.min(bytes.length, 8192); i++) {
        if (bytes[i] === 0) return true;
    }
    return false;
}

/** Cap oversized attachment content with an explicit truncation note. */
export function normalizeAttachContent(content: string): string {
    if (content.length <= MAX_ATTACH_CHARS) return content;
    return `${content.slice(0, MAX_ATTACH_CHARS)}\n[truncated]`;
}

/** Fenced context appendix appended to the prompt for the attached files.
 *  Whitespace-only attachments contribute nothing and are skipped, so an
 *  "attachment" of an empty file can't start a turn by itself. */
export function buildAttachContext(entries: AttachFileEntry[]): string {
    const meaningful = entries.filter((e) => e.content.trim().length > 0);
    return meaningful
        .map((e) => {
            const content = normalizeAttachContent(e.content);
            const fence = fenceFor(content);
            return `\n\n[Attached file: ${e.name}]\n${fence}${langFromPath(e.name)}\n${content.trimEnd()}\n${fence}`;
        })
        .join('');
}