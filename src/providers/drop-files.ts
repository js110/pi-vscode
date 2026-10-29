import * as vscode from 'vscode';
import type { DropResolveResult } from '../shared/protocol';
import { uriToPath, MAX_DROPPED_FILES } from '../shared/drop-files';

/** Validate dropped local paths without reading or parsing their contents. */
export async function resolveDroppedFiles(uris: string[]): Promise<DropResolveResult[]> {
    const results: DropResolveResult[] = [];
    for (const raw of uris.slice(0, MAX_DROPPED_FILES)) {
        const fsPath = uriToPath(raw);
        if (!fsPath) { results.push({ status: 'invalid' }); continue; }
        const uri = vscode.Uri.file(fsPath);
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            results.push(stat.type & (vscode.FileType.File | vscode.FileType.Directory)
                ? { status: 'path', path: uri.fsPath } : { status: 'invalid' });
        } catch { results.push({ status: 'invalid' }); }
    }
    if (uris.length > MAX_DROPPED_FILES) results.push({ status: 'limit' });
    return results;
}
