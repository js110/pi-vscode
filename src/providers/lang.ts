import * as vscode from 'vscode';
import type { Lang } from '../shared/protocol';

/**
 * Resolve the display language for Pi webviews (PRD C12). The
 * `pi-agent.displayLanguage` setting wins; `auto` follows the VS Code UI
 * language. This value never round-trips into ~/.pi/agent.
 */
export function resolveDisplayLang(): Lang {
    const setting = vscode.workspace
        .getConfiguration('pi-agent')
        .get<string>('displayLanguage', 'auto');
    if (setting === 'zh') return 'zh';
    if (setting === 'en') return 'en';
    return vscode.env.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
