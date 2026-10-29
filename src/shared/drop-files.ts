/**
 * Drag-and-drop path helpers. The host validates local URIs and sends paths
 * to the composer without reading the files.
 */

export const MAX_DROPPED_FILES = 100;

const IMAGE_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
]);

/** Split a `text/uri-list` payload into URIs (blank lines and `#` comments removed). */
export function parseUriList(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Parse VS Code's private drag payloads, which may accompany Explorer items. */
export function parseCodeDropUris(internalUris: string, resources: string, files: string): string[] {
    const localUris = (values: string[]) => values.filter(value => /^file:\/\//i.test(value));
    const internal = localUris(parseUriList(internalUris));
    if (internal.length) return internal;
    const parseArray = (value: string): string[] => {
        try {
            const parsed: unknown = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
        } catch { return []; }
    };
    const resourceUris = localUris(parseArray(resources));
    if (resourceUris.length) return resourceUris;
    return parseArray(files).filter(path => /^(?:\/|\\\\|[a-z]:[\\/])/i.test(path)).map(path => {
        const normalized = path.replace(/\\/g, '/');
        const encoded = normalized.split('/').map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)).join('/');
        return normalized.startsWith('//') ? `file:${encoded}` : `file://${normalized.startsWith('/') ? '' : '/'}${encoded}`;
    });
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
