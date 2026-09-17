/**
 * Built-in slash commands mirrored from the Pi CLI
 * (pi-coding-agent/dist/core/slash-commands.js). The SDK's prompt() only
 * dispatches extension-registered commands and expands skill/prompt-template
 * commands; built-in commands are the shell's responsibility, so the panel
 * host intercepts them before calling prompt().
 */
export interface BuiltinCommandInfo {
    name: string;
    description: string;
}

export const BUILTIN_COMMANDS: readonly BuiltinCommandInfo[] = [
    { name: 'settings', description: 'Open settings menu' },
    { name: 'model', description: 'Select model (opens selector UI)' },
    { name: 'tree', description: 'Navigate session tree (switch branches)' },
    { name: 'thinking', description: 'Set thinking level' },
    { name: 'scoped-models', description: 'Enable/disable models for Ctrl+P cycling' },
    { name: 'export', description: 'Export session (HTML default, or specify path: .html/.jsonl)' },
    { name: 'import', description: 'Import and resume a session from a JSONL file' },
    { name: 'share', description: 'Share session as a secret GitHub gist' },
    { name: 'copy', description: 'Copy last agent message to clipboard' },
    { name: 'name', description: 'Set session display name' },
    { name: 'session', description: 'Show session info and stats' },
    { name: 'changelog', description: 'Show changelog entries' },
    { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
    { name: 'fork', description: 'Create a new fork from a previous user message' },
    { name: 'clone', description: 'Duplicate the current session at the current position' },
    { name: 'trust', description: 'Save project trust decision for future sessions' },
    { name: 'login', description: 'Configure provider authentication' },
    { name: 'logout', description: 'Remove provider authentication' },
    { name: 'new', description: 'Start a new session' },
    { name: 'compact', description: 'Manually compact the session context' },
    { name: 'resume', description: 'Resume a different session' },
    { name: 'reload', description: 'Reload keybindings, extensions, skills, prompts, themes, and context files' },
    { name: 'quit', description: 'Quit Pi' },
];

const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(
    BUILTIN_COMMANDS.map((command) => command.name),
);

export function isBuiltinSlashCommandName(name: string): boolean {
    return BUILTIN_COMMAND_NAMES.has(name);
}

export interface ParsedSlashCommand {
    name: string;
    args: string;
}

/**
 * Parse a message that names a built-in slash command. Returns null for
 * anything else — unknown "/foo" input stays on the normal prompt path, where
 * the SDK dispatches extension commands and expands skill (/skill:name) and
 * prompt-template commands on its own.
 */
export function parseBuiltinSlashCommand(text: string): ParsedSlashCommand | null {
    const trimmed = text.trim();
    const match = trimmed.match(/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    const name = match[1].toLowerCase();
    if (!BUILTIN_COMMAND_NAMES.has(name)) return null;
    return { name, args: (match[2] ?? '').trim() };
}

/** Text of the last assistant message that carries text content, if any. */
export function extractLastAssistantText(messages: any[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || message.role !== 'assistant') continue;
        const content = message.content;
        const text =
            typeof content === 'string'
                ? content
                : Array.isArray(content)
                  ? content
                        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
                        .map((part: any) => part.text)
                        .join('\n')
                  : '';
        const trimmed = text.trim();
        if (trimmed) return trimmed;
    }
    return null;
}

export interface SlashMenuItemLike {
    name: string;
    label?: string;
    description?: string;
}

/**
 * Rank slash menu items for a typed query. Name matches beat description
 * matches (typing "/compa" means the compact command, not a skill whose
 * description happens to contain "compact"); ties keep the input order.
 * Non-matching items are dropped. An empty query keeps everything in order.
 */
export function rankSlashMenuItems<T extends SlashMenuItemLike>(items: readonly T[], query: string): T[] {
    const q = query.toLowerCase();
    const scored = items
        .map((item, index) => ({ item, index, score: _scoreSlashItem(item, q) }))
        .filter((entry) => entry.score < 3);
    scored.sort((a, b) => a.score - b.score || a.index - b.index);
    return scored.map((entry) => entry.item);
}

/** 0 = name/label prefix, 1 = name/label substring, 2 = description, 3 = no match. */
function _scoreSlashItem(item: SlashMenuItemLike, q: string): number {
    if (!q) return 0;
    const name = item.name.toLowerCase();
    const label = (item.label ?? `/${item.name}`).toLowerCase().replace(/^\//, '');
    if (name.startsWith(q) || label.startsWith(q)) return 0;
    if (name.includes(q) || label.includes(q)) return 1;
    if (item.description?.toLowerCase().includes(q)) return 2;
    return 3;
}
