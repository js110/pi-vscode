/**
 * Shared tool-safety classification, used by both the extension host
 * (approval memory) and the webview (hiding the "Remember" action) so the
 * dangerous-tool rule cannot drift between the two bundles.
 */

const DANGEROUS_TOOLS = new Set(['bash', 'powershell']);

/** Shell-execution tools must never be auto-approved from memory. */
export function isDangerousTool(toolName: string): boolean {
    const name = String(toolName ?? '').trim().toLowerCase();
    return DANGEROUS_TOOLS.has(name) || name.includes('shell');
}
