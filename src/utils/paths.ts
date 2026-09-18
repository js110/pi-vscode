import * as path from 'node:path';
import * as vscode from 'vscode';

/** Expand a leading `~/` (or a bare `~`) against the user's home directory. */
export function expandHome(filePath: string): string {
    if (filePath.startsWith('~/') || filePath === '~') {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
        return home ? path.join(home, filePath.slice(2)) : filePath;
    }
    return filePath;
}

/**
 * Resolve an agent-supplied path to an absolute one: expand `~`, keep absolute
 * paths as-is, otherwise anchor to the first workspace folder (falling back to
 * the process cwd when the window has no folder).
 */
export function resolveWorkspacePath(filePath: string, options: { expandHome?: boolean } = {}): string {
    const candidate = options.expandHome ? expandHome(filePath) : filePath;
    if (path.isAbsolute(candidate)) return candidate;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, candidate) : path.resolve(candidate);
}
