/**
 * Pure helpers for the Apply flow (PRD C3): mapping a code-block language to
 * candidate file extensions, ranking candidate files, and generating a
 * new-file name. Host-side fs/vscode work lives in providers/apply.ts.
 */

const LANG_EXTENSIONS: Record<string, string[]> = {
    typescript: ['ts', 'tsx'],
    ts: ['ts', 'tsx'],
    javascript: ['js', 'jsx', 'mjs', 'cjs'],
    js: ['js', 'jsx', 'mjs', 'cjs'],
    jsx: ['jsx'],
    tsx: ['tsx'],
    python: ['py'],
    py: ['py'],
    json: ['json'],
    jsonc: ['jsonc'],
    yaml: ['yaml', 'yml'],
    yml: ['yml'],
    toml: ['toml'],
    css: ['css'],
    scss: ['scss'],
    less: ['less'],
    html: ['html', 'htm'],
    xml: ['xml'],
    svg: ['svg'],
    markdown: ['md'],
    md: ['md'],
    shell: ['sh'],
    bash: ['sh'],
    sh: ['sh'],
    powershell: ['ps1'],
    sql: ['sql'],
    go: ['go'],
    rust: ['rs'],
    rs: ['rs'],
    java: ['java'],
    c: ['c', 'h'],
    cpp: ['cpp', 'hpp', 'cc'],
    csharp: ['cs'],
    ruby: ['rb'],
    php: ['php'],
    swift: ['swift'],
    kotlin: ['kt'],
    vue: ['vue'],
};

export function langToExtensions(lang: string): string[] {
    const key = String(lang ?? '').trim().toLowerCase();
    return LANG_EXTENSIONS[key] ?? [];
}

/**
 * Keep files matching one of the extensions, shallowest first (a root-level
 * file beats a deeply nested one), then alphabetical for determinism.
 */
export function rankCandidates(files: string[], extensions: string[]): string[] {
    if (extensions.length === 0) return [];
    const matching = files.filter((f) => {
        const ext = f.slice(f.lastIndexOf('.') + 1).toLowerCase();
        return extensions.includes(ext);
    });
    return matching.sort((x, y) => {
        const depthX = (x.match(/[/\\]/g) ?? []).length;
        const depthY = (y.match(/[/\\]/g) ?? []).length;
        if (depthX !== depthY) return depthX - depthY;
        return x.localeCompare(y);
    });
}

/** Timestamped new-file name, e.g. pi-apply-143005.ts. */
export function newFileName(extension: string, now: Date): string {
    const ext = extension.trim().toLowerCase() || 'txt';
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `pi-apply-${hh}${mm}${ss}.${ext}`;
}
