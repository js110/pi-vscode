/**
 * Conversation-quote context (user request): a text selection made inside
 * the chat transcript rides the next prompt the same way an editor selection
 * does — wrapped into a fenced block so the model sees exactly what the user
 * marked, without the wrap leaking into the visible composer text.
 *
 * Shared between the extension host (which performs the wrap in
 * SidebarProvider._handleMessage) and the webview (which enforces the size
 * cap at capture time), so the limit cannot drift between the two sides.
 */

import { fenceFor } from './mention';
import { t } from './i18n';

/** Mirrors the editor-selection cap (MAX_SELECTION_CHARS). */
export const MAX_QUOTE_CHARS = 40_000;

export function isQuoteTooLarge(text: string): boolean {
    return text.length > MAX_QUOTE_CHARS;
}

/** Fenced quote block prepended to the user's question at send time. */
export function buildQuotePrompt(quoted: string): string {
    const fence = fenceFor(quoted);
    return `${t('quote.intro')}\n\n${fence}\n${quoted}\n${fence}`;
}
