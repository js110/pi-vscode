/**
 * Pure builder for the Pi SDK session tool-selection options
 * (`CreateAgentSessionOptions.tools` / `.excludeTools`).
 *
 * SDK semantics (dist/core/sdk.d.ts, SDK 1.1.0):
 * - `tools` as plain names/patterns is an allowlist; a list of *only*
 *   `+name`/`-name` entries adjusts the default selection instead.
 *   Mixing the two styles throws, so the codemode/tool-search toggles can
 *   only append `+name` entries when the user's own list is empty or already
 *   delta-style — a plain allowlist stays untouched (the user can name
 *   `codemode` there themselves).
 * - `excludeTools` is a plain denylist applied after `tools`; no delta
 *   entries.
 */

export interface ToolSettingsConfig {
    allowedTools: string[];
    excludeTools: string[];
    enableCodemode: boolean;
    enableToolSearch: boolean;
}

export interface SessionToolOptions {
    tools?: string[];
    excludeTools?: string[];
    /** Enabled toggles that could not be applied because `allowedTools` is a
     *  plain allowlist (delta entries cannot be mixed with plain names). */
    skippedExtras: string[];
}

const isDeltaEntry = (entry: string): boolean => entry.startsWith('+') || entry.startsWith('-');

export function buildSessionToolOptions(cfg: ToolSettingsConfig): SessionToolOptions {
    const allowed = (cfg.allowedTools ?? []).map(s => s.trim()).filter(Boolean);
    const excluded = (cfg.excludeTools ?? []).map(s => s.trim()).filter(Boolean);

    const extras: string[] = [];
    const listed = (name: string): boolean => allowed.some(e => e === name || e === `+${name}`);
    if (cfg.enableCodemode && !listed('codemode')) extras.push('+codemode');
    if (cfg.enableToolSearch && !listed('tool_search')) extras.push('+tool_search');

    const deltaOnly = allowed.length > 0 && allowed.every(isDeltaEntry);
    let tools: string[] | undefined;
    let skippedExtras: string[] = [];
    if (allowed.length === 0) {
        tools = extras.length > 0 ? extras : undefined;
    } else if (deltaOnly) {
        tools = [...allowed, ...extras];
    } else {
        // Plain allowlist: appending "+x" would throw at session creation.
        tools = allowed;
        skippedExtras = extras;
    }

    return {
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(excluded.length > 0 ? { excludeTools: excluded } : {}),
        skippedExtras,
    };
}
