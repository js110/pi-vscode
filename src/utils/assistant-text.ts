/**
 * Plain-text extraction from an `AssistantMessage` (pi-ai) as returned by
 * `runtime.completeSimple()`. Its `content` is a block list
 * (`TextContent | ThinkingContent | ToolCall`)[]; stringifying the message
 * itself yields "[object Object]", so the text blocks must be picked out.
 */

export function extractAssistantText(reply: unknown): string {
    if (typeof reply === 'string') return reply;
    const content = (reply as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((c): c is { type: 'text'; text: string } =>
            typeof c === 'object' && c !== null &&
            (c as { type?: string }).type === 'text' &&
            typeof (c as { text?: string }).text === 'string',
        )
        .map((c) => c.text)
        .join('\n');
}