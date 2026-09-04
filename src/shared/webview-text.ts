// Pure, DOM-free text/value formatting helpers shared by the webview.
// No vscode, no state, no document — directly unit-testable.

export function escAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function formatTimestamp(ts: number | undefined | null): string {
    if (!ts) return '';
    const d = new Date(ts < 1e12 ? ts * 1000 : ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatTokenCount(n: number): string {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

/** Compact token formatting matching the Pi TUI footer. */
export function formatTokensCompact(count: number): string {
    if (!Number.isFinite(count) || count < 0) return '0';
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}

export function truncate(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '...';
}

export function tryParseJSON(s: string): any {
    try {
        return JSON.parse(s);
    } catch {
        return s;
    }
}

export function extractText(msg: any): string {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
    }
    return msg.text ?? '';
}

export function extractThinking(msg: any): string {
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((c: any) => c.type === 'thinking')
            .map((c: any) => c.thinking ?? c.text ?? '')
            .join('');
    }
    return msg.thinking ?? '';
}

export function extractToolResultText(result: any): string {
    if (result === undefined || result === null) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
        return result
            .map((item: any) => (typeof item === 'string' ? item : item?.text ?? ''))
            .filter(Boolean)
            .join('\n');
    }
    if (typeof result === 'object') {
        if (Array.isArray(result.content)) {
            const text = result.content
                .map((item: any) => (typeof item === 'string' ? item : item?.text ?? ''))
                .filter(Boolean)
                .join('\n');
            if (text) return text;
        }
        if (result.text) return result.text;
        if (result.output) return result.output;
    }
    return JSON.stringify(result, null, 2);
}

export function formatToolArgs(args: any): string {
    if (!args || typeof args !== 'object') return '';
    const entries = Object.entries(args);
    if (entries.length === 0) return '';
    return entries
        .map(([k, v]) => {
            const val = typeof v === 'string' ? v : JSON.stringify(v);
            return `${k}: ${val}`;
        })
        .join('\n');
}

export function buildStatusHtml(status: string): string {
    if (status === 'done') return '';
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    return `<span class="tool-status ${status}">${label}</span>`;
}

const TOOL_ICONS: Record<string, string> = {
    bash: `<svg class="tool-icon-svg" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4l4 4-4 4M8 12h6"/></svg>`,
    python: `<svg class="tool-icon-svg" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 2h6v4H5zM5 10h6v4H5zM5 6a2 2 0 1 0 0-4M11 10a2 2 0 1 0 0 4"/></svg>`,
    read: `<svg class="tool-icon-svg" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 2h8v12H4zM4 5h8M4 8h5"/></svg>`,
    write: `<svg class="tool-icon-svg" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg>`,
    edit: `<svg class="tool-icon-svg" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg>`,
    glob: `<svg class="tool-icon-svg" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg>`,
    grep: `<svg class="tool-icon-svg" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg>`,
    list: `<svg class="tool-icon-svg" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 3h2v2H3zM3 7h2v2H3zM3 11h2v2H3zM7 3h6M7 7h6M7 11h6"/></svg>`,
};

const DEFAULT_TOOL_ICON = `<svg class="tool-icon-svg" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2v4l2 2M12 6a6 6 0 1 1-8 0 6 6 0 0 1 8 0z"/></svg>`;

export function getToolIcon(name: string): string {
    return TOOL_ICONS[name.toLowerCase()] ?? DEFAULT_TOOL_ICON;
}

export function getToolLabel(name: string, args: any): string {
    switch (name.toLowerCase()) {
        case 'bash':
            return args?.command ? truncate(args.command, 60) : 'Execute command';
        case 'read':
            return args?.path ? `Read ${truncate(args.path, 50)}` : 'Read file';
        case 'write':
            return args?.path ? `Write ${truncate(args.path, 50)}` : 'Write file';
        case 'edit':
            return args?.path ? `Edit ${truncate(args.path, 50)}` : 'Edit file';
        case 'glob':
            return args?.pattern ? `Glob ${truncate(args.pattern, 50)}` : 'Find files';
        case 'grep':
            return args?.pattern ? `Grep ${truncate(args.pattern, 50)}` : 'Search files';
        default:
            return name;
    }
}

const FILE_ICONS: Record<string, string> = {
    ts: '&#128312;', tsx: '&#128312;',
    js: '&#128313;', jsx: '&#128313;',
    json: '&#128312;',
    css: '&#128309;', scss: '&#128309;',
    html: '&#128992;',
    md: '&#128310;',
    py: '&#128311;',
    svg: '&#128993;',
};

export function getFileIcon(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return FILE_ICONS[ext] ?? '&#128196;';
}

export function renderDiffLines(diff: string): string {
    const lines = diff.split('\n');
    const htmlLines: string[] = [];

    for (const line of lines) {
        if (line.startsWith('--- ') || line.startsWith('+++ ')) {
            continue;
        }
        if (line.startsWith('@@')) {
            htmlLines.push(`<div class="diff-line diff-line-hunk">${escAttr(line)}</div>`);
        } else if (line.startsWith('+')) {
            htmlLines.push(`<div class="diff-line diff-line-add">${escAttr(line)}</div>`);
        } else if (line.startsWith('-')) {
            htmlLines.push(`<div class="diff-line diff-line-del">${escAttr(line)}</div>`);
        } else {
            htmlLines.push(`<div class="diff-line diff-line-ctx">${escAttr(line)}</div>`);
        }
    }

    return htmlLines.join('');
}
