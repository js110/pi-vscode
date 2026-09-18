/**
 * Markdown export for a Pi session (the panel's `/export` command).
 *
 * Pure formatting: the input is the serialized SDK message list, the output a
 * self-contained Markdown document. Assistant thinking rides GitHub-flavored
 * `<details>` blocks so long reasoning collapses in common Markdown viewers,
 * and tool output is fenced with a run of backticks guaranteed to be longer
 * than any run inside the content itself.
 */

export interface SessionExportMeta {
    name?: string;
    model?: string;
    exportedAtMs: number;
}

function messageParts(content: unknown): any[] {
    if (Array.isArray(content)) return content;
    return [];
}

function messageText(content: unknown): string {
    if (typeof content === 'string') return content;
    return messageParts(content)
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n\n');
}

/** A fence run strictly longer than any backtick run inside `content`. */
function fence(content: string): string {
    let longest = 0;
    for (const run of content.match(/`+/g) ?? []) {
        longest = Math.max(longest, run.length);
    }
    const ticks = '`'.repeat(Math.max(3, longest + 1));
    return `${ticks}\n${content}\n${ticks}`;
}

function thinkingBlock(text: string): string {
    return `<details>\n<summary>Thinking</summary>\n\n${text}\n\n</details>`;
}

function renderUserMessage(msg: any): string[] {
    const parts: string[] = [];
    const text = messageText(msg.content);
    if (text.trim()) parts.push(text);
    let images = 0;
    for (const part of messageParts(msg.content)) {
        if (part?.type === 'image' || part?.type === 'image_url') images++;
    }
    if (images > 0) {
        parts.push(`> [image attachment${images > 1 ? ` x${images}` : ''}]`);
    }
    return parts.length > 0 ? ['## User', '', ...parts, ''] : [];
}

function renderAssistantMessage(msg: any): string[] {
    const parts: string[] = [];
    const thinking = messageParts(msg.content)
        .filter((part) => part?.type === 'thinking' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n\n');
    if (thinking.trim()) parts.push(thinkingBlock(thinking));
    const text = messageText(msg.content);
    if (text.trim()) parts.push(text);
    return parts.length > 0 ? ['## Assistant', '', ...parts, ''] : [];
}

function renderToolMessage(msg: any): string[] {
    const toolName = msg.toolName ?? 'tool';
    const suffix = msg.isError ? ' (error)' : '';
    const output = messageText(msg.content);
    const body = output.trim() ? fence(output) : '(no output)';
    return [`## Tool: ${toolName}${suffix}`, '', body, ''];
}

export function buildSessionMarkdown(messages: any[], meta: SessionExportMeta): string {
    const lines: string[] = [];
    lines.push(`# ${meta.name?.trim() || 'Pi session'}`, '');
    lines.push(`- Model: ${meta.model?.trim() || '-'}`);
    lines.push(`- Exported: ${new Date(meta.exportedAtMs).toISOString()}`);
    lines.push('', '---', '');

    for (const msg of messages) {
        if (!msg) continue;
        const role = msg.role ?? 'unknown';
        if (role === 'user') {
            lines.push(...renderUserMessage(msg));
        } else if (role === 'assistant') {
            lines.push(...renderAssistantMessage(msg));
        } else if (role === 'toolResult' || role === 'tool') {
            lines.push(...renderToolMessage(msg));
        }
    }

    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
}

/** Filesystem-safe, collision-friendly default name for the save dialog. */
export function suggestedExportFileName(name: string | undefined, atMs: number): string {
    const stamp = new Date(atMs).toISOString().slice(0, 10);
    const base = (name ?? '')
        .trim()
        .replace(/[^\w一-鿿.-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 60)
        .replace(/[-.]+$/g, '');
    return `${base || 'pi-session'}-${stamp}.md`;
}
