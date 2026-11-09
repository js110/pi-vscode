import * as vscode from 'vscode';
import type { DropResolveResult } from '../shared/protocol';
import { uriToPath, MAX_DROPPED_FILES, isImagePath } from '../shared/drop-files';

/** Hard cap for host-side image reads feeding the composer chip (the webview
 *  canvas path downsizes to the provider limit afterwards). */
const MAX_HOST_IMAGE_READ_BYTES = 25 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
};

/** Validate dropped local paths; images are read as data URLs so the webview
 *  can attach them as thumbnails, directories are flagged so the composer
 *  attaches them as path references instead of unreadable content. */
export async function resolveDroppedFiles(uris: string[]): Promise<DropResolveResult[]> {
    const results: DropResolveResult[] = [];
    for (const raw of uris.slice(0, MAX_DROPPED_FILES)) {
        const fsPath = uriToPath(raw);
        if (!fsPath) { results.push({ status: 'invalid' }); continue; }
        const uri = vscode.Uri.file(fsPath);
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type & vscode.FileType.Directory) {
                results.push({ status: 'path', path: uri.fsPath, directory: true });
                continue;
            }
            if (!(stat.type & vscode.FileType.File)) { results.push({ status: 'invalid' }); continue; }
            if (isImagePath(uri.fsPath) && stat.size <= MAX_HOST_IMAGE_READ_BYTES) {
                const data = await vscode.workspace.fs.readFile(uri);
                const ext = uri.fsPath.slice(uri.fsPath.lastIndexOf('.') + 1).toLowerCase();
                const mime = IMAGE_MIME_BY_EXT[ext] ?? 'application/octet-stream';
                results.push({
                    status: 'path',
                    path: uri.fsPath,
                    image: `data:${mime};base64,${Buffer.from(data).toString('base64')}`,
                });
                continue;
            }
            results.push({ status: 'path', path: uri.fsPath });
        } catch { results.push({ status: 'invalid' }); }
    }
    if (uris.length > MAX_DROPPED_FILES) results.push({ status: 'limit' });
    return results;
}
