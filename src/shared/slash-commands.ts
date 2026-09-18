/**
 * Built-in slash commands mirrored from the Pi CLI
 * (pi-coding-agent/dist/core/slash-commands.js). The SDK's prompt() only
 * dispatches extension-registered commands and expands skill/prompt-template
 * commands; built-in commands are the shell's responsibility, so the panel
 * host intercepts them before calling prompt().
 *
 * `support` is the support matrix: `native` means the host implements the
 * command (tab.ts intercepts and executes it); `unsupported` means it is
 * recognised — and refused with a message — rather than leaking to the model
 * as plain text. `getCommands()` advertises only native commands, so the slash
 * menu can never offer a command the host cannot run. The mirror must still
 * list every SDK builtin for the guard test in
 * test/unit/shared/slash-commands.test.ts.
 */
export type BuiltinSupport = 'native' | 'unsupported';

export interface BuiltinCommandInfo {
    name: string;
    description: string;
    support: BuiltinSupport;
}

const BUILTIN_COMMAND_DEFS = [
    { name: 'settings', description: 'Open settings menu', support: 'native' },
    { name: 'model', description: 'Select model (opens selector UI)', support: 'native' },
    { name: 'tree', description: 'Navigate session tree (switch branches)', support: 'unsupported' },
    { name: 'thinking', description: 'Set thinking level', support: 'native' },
    { name: 'scoped-models', description: 'Enable/disable models for Ctrl+P cycling', support: 'unsupported' },
    { name: 'export', description: 'Export the session as a Markdown file', support: 'native' },
    { name: 'import', description: 'Import and resume a session from a JSONL file', support: 'unsupported' },
    { name: 'share', description: 'Share session as a secret GitHub gist', support: 'unsupported' },
    { name: 'copy', description: 'Copy last agent message to clipboard', support: 'native' },
    { name: 'name', description: 'Set session display name', support: 'native' },
    { name: 'session', description: 'Show session info and stats', support: 'native' },
    { name: 'changelog', description: 'Show changelog entries', support: 'unsupported' },
    { name: 'hotkeys', description: 'Show all keyboard shortcuts', support: 'unsupported' },
    { name: 'fork', description: 'Create a new fork from a previous user message', support: 'unsupported' },
    { name: 'clone', description: 'Duplicate the current session at the current position', support: 'unsupported' },
    { name: 'trust', description: 'Save project trust decision for future sessions', support: 'unsupported' },
    { name: 'login', description: 'Configure provider authentication', support: 'native' },
    { name: 'logout', description: 'Remove provider authentication', support: 'unsupported' },
    { name: 'new', description: 'Start a new session', support: 'native' },
    { name: 'compact', description: 'Manually compact the session context', support: 'native' },
    { name: 'resume', description: 'Resume a different session', support: 'native' },
    { name: 'reload', description: 'Reload keybindings, extensions, skills, prompts, themes, and context files', support: 'unsupported' },
    { name: 'quit', description: 'Quit Pi', support: 'unsupported' },
] as const satisfies readonly BuiltinCommandInfo[];

export const BUILTIN_COMMANDS: readonly BuiltinCommandInfo[] = BUILTIN_COMMAND_DEFS;

type BuiltinCommandDef = (typeof BUILTIN_COMMAND_DEFS)[number];

/** Names the host intercepts and fully executes. */
export type SupportedBuiltinCommandName = Extract<BuiltinCommandDef, { support: 'native' }>['name'];

const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(
    BUILTIN_COMMAND_DEFS.map((command) => command.name),
);

const SUPPORTED_BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(
    BUILTIN_COMMAND_DEFS.filter((command) => command.support === 'native').map((command) => command.name),
);

export function isBuiltinSlashCommandName(name: string): boolean {
    return BUILTIN_COMMAND_NAMES.has(name);
}

export function isSupportedBuiltinSlashCommandName(name: string): name is SupportedBuiltinCommandName {
    return SUPPORTED_BUILTIN_COMMAND_NAMES.has(name);
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

/**
 * Single classification seam for every slash entry point (prompt, steer,
 * queueMessage, followUp, editQueuedMessage): either the text is a built-in
 * command (with its support verdict) or it passes through to the model.
 */
export type SlashInput =
    | { kind: 'passthrough' }
    | { kind: 'builtin'; name: SupportedBuiltinCommandName; args: string; supported: true }
    | { kind: 'builtin'; name: string; args: string; supported: false };

export function classifySlashInput(text: string): SlashInput {
    const parsed = parseBuiltinSlashCommand(text);
    if (!parsed) return { kind: 'passthrough' };
    if (isSupportedBuiltinSlashCommandName(parsed.name)) {
        return { kind: 'builtin', name: parsed.name, args: parsed.args, supported: true };
    }
    return { kind: 'builtin', name: parsed.name, args: parsed.args, supported: false };
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
