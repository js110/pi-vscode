/**
 * Approval memory: remembers "allow this tool" decisions so future calls can
 * be auto-approved without showing the approval card again (PRD 9.3 / C2).
 *
 * Two scopes:
 *  - session: lives on this ApprovalMemory instance (one per tab, dies with
 *    the tab);
 *  - global: shared by every tab through the injected GlobalRuleStore, which
 *    the extension host backs with globalState.
 *
 * Shell-execution tools (bash/powershell) are dangerous: they are never
 * auto-approved from memory and attempts to remember them are ignored.
 */

import type { ApprovalRuleInfo, ApprovalScope } from '../shared/protocol';
import { isDangerousTool } from '../shared/tool-safety';

export type { ApprovalRuleInfo, ApprovalScope };
export { isDangerousTool };

export interface ApprovalDecision {
    approved: boolean;
    /** Set only when the call was auto-approved from a remembered rule. */
    scope?: ApprovalScope;
}

/** Sync read / persist view of the global (cross-tab) rule list. */
export interface GlobalRuleStore {
    load(): ApprovalRuleInfo[];
    save(rules: ApprovalRuleInfo[]): void;
}

function normalizeTool(toolName: string): string {
    return String(toolName ?? '').trim().toLowerCase();
}

export class ApprovalMemory {
    private _sessionRules: ApprovalRuleInfo[];

    constructor(
        private _global: GlobalRuleStore,
        private _now: () => number = Date.now,
    ) {
        this._sessionRules = [];
    }

    check(toolName: string): ApprovalDecision {
        if (isDangerousTool(toolName)) {
            return { approved: false };
        }
        const name = normalizeTool(toolName);
        if (this._sessionRules.some((r) => r.tool === name)) {
            return { approved: true, scope: 'session' };
        }
        if (this._global.load().some((r) => r.tool === name)) {
            return { approved: true, scope: 'global' };
        }
        return { approved: false };
    }

    remember(toolName: string, scope: ApprovalScope): void {
        if (isDangerousTool(toolName)) {
            return;
        }
        const name = normalizeTool(toolName);
        if (scope === 'session') {
            if (!this._sessionRules.some((r) => r.tool === name)) {
                this._sessionRules = [...this._sessionRules, { tool: name, createdAt: this._now() }];
            }
            return;
        }
        const rules = this._global.load();
        if (!rules.some((r) => r.tool === name)) {
            this._global.save([...rules, { tool: name, createdAt: this._now() }]);
        }
    }

    listSessionRules(): ApprovalRuleInfo[] {
        return [...this._sessionRules];
    }

    revokeGlobal(tool: string): void {
        const name = normalizeTool(tool);
        this._global.save(this._global.load().filter((r) => r.tool !== name));
    }

    clearGlobal(): void {
        this._global.save([]);
    }
}
