/**
 * Disk operations around session files: move-to-trash (deletion) and
 * size-capped reads (full-text search). Host-side only (Node fs).
 */

import * as fs from 'fs';
import * as path from 'path';

/** Sessions moved here on delete keep the same volume, so rename is atomic. */
export const TRASH_DIR_NAME = '.pi-session-trash';

export async function trashSessionFile(sessionPath: string): Promise<void> {
    const trashDir = path.join(path.dirname(sessionPath), TRASH_DIR_NAME);
    await fs.promises.mkdir(trashDir, { recursive: true });
    const dest = path.join(trashDir, path.basename(sessionPath));
    try {
        await fs.promises.rm(dest, { force: true });
    } catch { /* first delete */ }
    await fs.promises.rename(sessionPath, dest);
}

export interface SessionFileProbe {
    sizeBytes: number;
    name: string;
}

export async function probeSessionFile(sessionPath: string): Promise<SessionFileProbe | null> {
    try {
        const st = await fs.promises.stat(sessionPath);
        return { sizeBytes: st.size, name: path.basename(sessionPath) };
    } catch {
        return null;
    }
}

/** Read the beginning of a session file, capped at `maxBytes`. */
export async function readSessionChunk(
    sessionPath: string,
    maxBytes = 512 * 1024,
): Promise<string | null> {
    const READ_SIZE = 64 * 1024;
    try {
        const fd = await fs.promises.open(sessionPath, 'r');
        try {
            const total = Math.min(maxBytes, 128 * 1024 * 1024);
            const parts: Buffer[] = [];
            let position = 0;
            while (position < total) {
                const want = Math.min(READ_SIZE, total - position);
                const buf = Buffer.alloc(want);
                const { bytesRead } = await fd.read(buf, 0, want, position);
                if (bytesRead === 0) break;
                parts.push(buf.subarray(0, bytesRead));
                position += bytesRead;
            }
            return Buffer.concat(parts).toString('utf-8');
        } finally {
            await fd.close();
        }
    } catch {
        return null;
    }
}

/** First whitespace-trimmed line containing `needle` anywhere in the chunk. */
export function findSnippet(chunk: string | null, needle: string): string | undefined {
    if (!chunk) return undefined;
    const q = needle.toLowerCase();
    const idx = chunk.toLowerCase().indexOf(q);
    if (idx < 0) return undefined;
    const lineStart = chunk.lastIndexOf('\n', idx) + 1;
    const lineEnd = chunk.indexOf('\n', idx);
    const rawLine = chunk.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
    const line = rawLine.trim();
    const rel = idx - lineStart - (rawLine.length - line.length);
    if (rel < 0) return line;
    const max = 160;
    if (line.length > max) {
        const from = Math.max(0, rel - 20);
        return `…${line.slice(from, rel + max - 40)}…`.trim();
    }
    return line;
}