/**
 * Drag-and-drop file references (PRD C7 / AC-FN-21): the webview forwards
 * `text/uri-list` entries from drop events; the host decodes them to
 * workspace-relative paths that ride the same @-mention injection path.
 * Pure URI and path logic lives here so it stays unit-testable.
 */

const IMAGE_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif',
]);

/** Split a `text/uri-list` payload into URIs (blank lines and `#` comments removed). */
export function parseUriList(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Decode a `file://` URI to a filesystem path. Returns null for other
 * schemes or malformed percent-encoding. Windows drive URIs (`file:///C:/…`)
 * lose their leading slash; UNC hosts come back as `//server/share/…`.
 */
export function uriToPath(uri: string): string | null {
    if (!/^file:\/\//i.test(uri)) return null;
    const after = uri.slice('file://'.length);
    const slash = after.indexOf('/');
    const authority = slash < 0 ? after : after.slice(0, slash);
    let path: string;
    try {
        path = decodeURIComponent(slash < 0 ? '/' : after.slice(slash));
    } catch {
        return null;
    }
    if (authority && authority.toLowerCase() !== 'localhost') {
        return `//${authority}${path}`;
    }
    const drive = /^\/([A-Za-z]:\/.*)$/.exec(path);
    if (drive) return drive[1];
    return path;
}

/**
 * Workspace-relative posix path when `fsPath` lies inside one of the roots
 * (matched case-insensitively — Windows drives); null otherwise. Paths that
 * would escape a root via `..` segments are rejected outright.
 */
export function relativeToWorkspace(fsPath: string, workspaceRoots: string[]): string | null {
    const path = fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
    for (const raw of workspaceRoots) {
        const root = raw.replace(/\\/g, '/').replace(/\/+$/, '');
        if (!root) continue;
        if (`${path.toLowerCase()}/`.startsWith(`${root.toLowerCase()}/`)) {
            const segments = path.slice(root.length + 1).split('/');
            if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
            return segments.join('/');
        }
    }
    return null;
}

/** Whether a path looks like an image file (those ride the image-attach path). */
export function isImagePath(path: string): boolean {
    const dot = path.lastIndexOf('.');
    if (dot < 0) return false;
    return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}
