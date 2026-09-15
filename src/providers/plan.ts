/**
 * Plan mode state machine (PRD C8 / 8.5): 关闭 → 规划中 → 待批准 → 执行中 →
 * 已完成 / 已中断, with 失败暂停 on step failure, dangerous-tool cards,
 * write conflicts or rate limiting. Pure logic — no vscode imports — so the
 * transitions stay unit-testable; the Tab glue drives it and mirrors
 * snapshots to the webview.
 */

import type { PlanPhase, PlanSnapshot, PlanStep, PlanStepStatus } from '../shared/protocol';

export type { PlanPhase, PlanSnapshot, PlanStep, PlanStepStatus };

/**
 * Core tools considered read-only for Plan planning (PRD 9.5: 仅允许只读工具).
 * Write-class core tools (bash/powershell/edit/write/edit-diff) are excluded;
 * the toolset restriction also drops extension tools for the planning turn.
 */
export const PLAN_READONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

/** Tools whose calls the plan approval covers during 执行中 (non-dangerous
 *  core tools; dangerous ones still prompt per PRD 9.5 危险工具例外). */
export const PLAN_CREDENTIAL_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'edit-diff'];

export class PlanMachine {
    private _phase: PlanPhase = 'off';
    private _steps: PlanStep[] = [];
    private _currentStep = -1;
    private _pausedReason: string | undefined;

    static fromSnapshot(snap: PlanSnapshot): PlanMachine {
        const m = new PlanMachine();
        m._phase = snap.phase;
        m._steps = snap.steps.map((s) => ({ ...s }));
        m._currentStep = snap.currentStep;
        m._pausedReason = snap.pausedReason;
        return m;
    }

    snapshot(): PlanSnapshot {
        return {
            phase: this._phase,
            steps: this._steps.map((s) => ({ ...s })),
            currentStep: this._currentStep,
            ...(this._pausedReason !== undefined ? { pausedReason: this._pausedReason } : {}),
        };
    }

    /** User switches into Plan mode (from off, or re-planning after done). */
    startPlanning(): boolean {
        if (this._phase !== 'off') return false;
        this._phase = 'planning';
        this._steps = [];
        this._currentStep = -1;
        this._pausedReason = undefined;
        return true;
    }

    /** Re-enter planning after an interruption, keeping only finished steps. */
    restartPlanning(): boolean {
        if (this._phase !== 'interrupted') return false;
        this._steps = this._steps.filter((s) => s.status === 'done');
        this._phase = 'planning';
        this._currentStep = -1;
        this._pausedReason = undefined;
        return true;
    }

    /** User backs out of planning / the plan card (切回对话/取消). */
    cancel(): boolean {
        if (this._phase !== 'planning' && this._phase !== 'awaitingApproval') return false;
        this._phase = 'off';
        this._steps = [];
        this._currentStep = -1;
        this._pausedReason = undefined;
        return true;
    }

    /** The AI produced a plan (parsed from its planning-turn reply). */
    planProduced(titles: string[]): boolean {
        if (this._phase !== 'planning') return false;
        this._steps = titles.map((title) => ({ title, status: 'pending' as const }));
        this._phase = 'awaitingApproval';
        return true;
    }

    /** User asks the AI to redo the plan. */
    replan(): boolean {
        if (this._phase !== 'awaitingApproval') return false;
        this._phase = 'planning';
        return true;
    }

    /** Local step edits while the plan card is up. */
    setSteps(titles: string[]): boolean {
        if (this._phase !== 'awaitingApproval') return false;
        this._steps = titles.map((title) => ({ title, status: 'pending' as const }));
        return true;
    }

    /** Plan approved → execution begins from the first step. */
    approve(): boolean {
        if (this._phase !== 'awaitingApproval') return false;
        this._steps = this._steps.map((s) => ({ ...s, status: 'pending' as const }));
        this._pausedReason = undefined;
        if (this._steps.length === 0) {
            this._currentStep = -1;
            this._phase = 'done';
            return true;
        }
        this._currentStep = 0;
        this._phase = 'executing';
        return true;
    }

    /** Back to 待批准 with an adjusted plan (失败暂停 → 调整计划重新批准). */
    adjust(titles: string[]): boolean {
        if (this._phase !== 'paused') return false;
        this._steps = titles.map((title) => ({ title, status: 'pending' as const }));
        this._currentStep = -1;
        this._pausedReason = undefined;
        this._phase = 'awaitingApproval';
        return true;
    }

    stepStarted(index: number): boolean {
        if (this._phase !== 'executing' || index < 0 || index >= this._steps.length) return false;
        this._steps = this._steps.map((s, i) => (i === index ? { ...s, status: 'running' as const } : s));
        this._currentStep = index;
        return true;
    }

    stepDone(index: number): boolean {
        if (this._phase !== 'executing' || index < 0 || index >= this._steps.length) return false;
        this._steps = this._steps.map((s, i) => (i === index ? { ...s, status: 'done' as const } : s));
        if (this._steps.every((s) => s.status === 'done')) {
            this._phase = 'done';
            this._currentStep = -1;
        }
        return true;
    }

    /** 失败暂停 (step failure / rate limit / write conflict / denied card). */
    fail(index: number, reason: string): boolean {
        if (this._phase !== 'executing' || index < 0 || index >= this._steps.length) return false;
        this._steps = this._steps.map((s, i) => (i === index ? { ...s, status: 'failed' as const } : s));
        this._currentStep = index;
        this._pausedReason = reason;
        this._phase = 'paused';
        return true;
    }

    /** Resume from the paused step (repair done). */
    resume(): boolean {
        if (this._phase !== 'paused') return false;
        this._pausedReason = undefined;
        this._phase = 'executing';
        return true;
    }

    /** Esc during execution: done steps kept, running/pending cancelled. */
    interrupt(): boolean {
        if (this._phase !== 'executing') return false;
        this._steps = this._steps.map((s) => ({
            ...s,
            status: s.status === 'done' || s.status === 'failed' ? s.status : ('cancelled' as const),
        }));
        this._currentStep = -1;
        this._pausedReason = undefined;
        this._phase = 'interrupted';
        return true;
    }

    /** 放弃 from 失败暂停 (failed step stays failed). */
    abandon(): boolean {
        if (this._phase !== 'paused') return false;
        this._currentStep = -1;
        this._pausedReason = undefined;
        this._phase = 'interrupted';
        return true;
    }

    close(): boolean {
        if (this._phase !== 'done' && this._phase !== 'interrupted') return false;
        this._phase = 'off';
        this._steps = [];
        this._currentStep = -1;
        this._pausedReason = undefined;
        return true;
    }
}

/**
 * Parse the plan the model emitted during the planning turn: the last fenced
 * block tagged `plan`, one step per line, with `1.` / `-` markers stripped.
 */
export function parsePlanBlock(text: string): string[] {
    const blocks: string[][] = [];
    const lines = text.split('\n');
    let inPlan = false;
    for (const line of lines) {
        if (!inPlan && /^```\s*plan\s*$/.test(line.trim())) {
            inPlan = true;
            blocks.push([]);
            continue;
        }
        if (inPlan && /^```\s*$/.test(line.trim())) {
            inPlan = false;
            continue;
        }
        if (inPlan) {
            blocks[blocks.length - 1].push(line.replace(/^\s*(?:\d+[.)]|[-*])\s+/, '').trim());
        }
    }
    if (blocks.length === 0) return [];
    return blocks[blocks.length - 1].filter((line) => line.length > 0);
}
