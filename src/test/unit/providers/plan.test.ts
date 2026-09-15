import { describe, it, expect } from 'vitest';
import {
    PlanMachine,
    parsePlanBlock,
    PLAN_READONLY_TOOLS,
    type PlanPhase,
    type PlanSnapshot,
} from '../../../providers/plan';

function snapshotSteps(m: PlanMachine): { title: string; status: string }[] {
    return (m.snapshot().steps as { title: string; status: string }[]).map((s) => ({
        title: s.title,
        status: s.status,
    }));
}

describe('PlanMachine lifecycle', () => {
    it('starts closed and cannot approve before a plan exists', () => {
        const m = new PlanMachine();
        expect(m.snapshot().phase).toBe<PlanPhase>('off');
        expect(m.approve()).toBe(false);
    });

    it('moves off → planning → awaitingApproval → executing → done', () => {
        const m = new PlanMachine();
        m.startPlanning();
        expect(m.snapshot().phase).toBe('planning');
        m.planProduced(['step A', 'step B']);
        expect(m.snapshot().phase).toBe('awaitingApproval');
        expect(m.approve()).toBe(true);
        expect(m.snapshot().phase).toBe('executing');
        m.stepStarted(0);
        m.stepDone(0);
        m.stepStarted(1);
        m.stepDone(1);
        const snap = m.snapshot();
        expect(snap.phase).toBe('done');
        expect(snap.steps.every((s) => s.status === 'done')).toBe(true);
    });

    it('supports replan from awaitingApproval and cancel back to off', () => {
        const m = new PlanMachine();
        m.startPlanning();
        m.planProduced(['a']);
        m.replan();
        expect(m.snapshot().phase).toBe('planning');
        m.planProduced(['b']);
        m.cancel();
        expect(m.snapshot().phase).toBe('off');
    });

    it('lets the user locally edit steps while awaiting approval', () => {
        const m = new PlanMachine();
        m.startPlanning();
        m.planProduced(['a', 'b', 'c']);
        m.setSteps(['a', 'c']);
        expect(snapshotSteps(m)).toEqual([
            { title: 'a', status: 'pending' },
            { title: 'c', status: 'pending' },
        ]);
        expect(m.approve()).toBe(true);
        expect(m.snapshot().steps).toHaveLength(2);
    });

    it('treats approving an empty plan as done instead of executing', () => {
        const m = new PlanMachine();
        m.startPlanning();
        m.planProduced(['a']);
        m.setSteps([]);
        expect(m.approve()).toBe(true);
        expect(m.snapshot().phase).toBe('done');
        expect(m.snapshot().currentStep).toBe(-1);
    });
});

describe('PlanMachine execution edges', () => {
    function executing(): PlanMachine {
        const m = new PlanMachine();
        m.startPlanning();
        m.planProduced(['a', 'b', 'c']);
        m.approve();
        return m;
    }

    it('pauses on failure and resumes from the current step', () => {
        const m = executing();
        m.stepStarted(0);
        m.stepDone(0);
        m.stepStarted(1);
        m.fail(1, 'write conflict');
        const snap = m.snapshot();
        expect(snap.phase).toBe('paused');
        expect(snap.pausedReason).toBe('write conflict');
        expect(snap.steps[1].status).toBe('failed');
        expect(snap.currentStep).toBe(1);
        m.resume();
        expect(m.snapshot().phase).toBe('executing');
        // Retry the same step from its start.
        m.stepStarted(1);
        m.stepDone(1);
        m.stepStarted(2);
        m.stepDone(2);
        expect(m.snapshot().phase).toBe('done');
    });

    it('re-approval after pause keeps edited steps and resets statuses', () => {
        const m = executing();
        m.stepStarted(0);
        m.stepDone(0);
        m.stepStarted(1);
        m.fail(1, 'boom');
        m.adjust(['a (revised)', 'b (revised)']);
        expect(m.snapshot().phase).toBe('awaitingApproval');
        expect(m.approve()).toBe(true);
        expect(m.snapshot().steps.every((s) => s.status === 'pending')).toBe(true);
    });

    it('interrupts on Esc: completed steps kept, running/pending cancelled', () => {
        const m = executing();
        m.stepStarted(0);
        m.stepDone(0);
        m.stepStarted(1);
        m.interrupt();
        const snap = m.snapshot();
        expect(snap.phase).toBe('interrupted');
        expect(snapshotSteps(m)).toEqual([
            { title: 'a', status: 'done' },
            { title: 'b', status: 'cancelled' },
            { title: 'c', status: 'cancelled' },
        ]);
    });

    it('abandons from pause the same way as interruption', () => {
        const m = executing();
        m.stepStarted(0);
        m.fail(0, 'x');
        m.abandon();
        expect(m.snapshot().phase).toBe('interrupted');
        expect(m.snapshot().steps[0].status).toBe('failed');
    });

    it('closes from done/interrupted back to off', () => {
        const m = executing();
        m.interrupt();
        expect(m.close()).toBe(true);
        expect(m.snapshot().phase).toBe('off');
        const m2 = executing();
        m2.stepStarted(0);
        m2.stepDone(0);
        m2.stepStarted(1);
        m2.stepDone(1);
        m2.stepStarted(2);
        m2.stepDone(2);
        expect(m2.close()).toBe(true);
        expect(m2.snapshot().phase).toBe('off');
    });

    it('restarts planning from interrupted keeping finished work untouched', () => {
        const m = executing();
        m.stepStarted(0);
        m.stepDone(0);
        m.interrupt();
        m.restartPlanning();
        expect(m.snapshot().phase).toBe('planning');
        expect(snapshotSteps(m)).toEqual([{ title: 'a', status: 'done' }]);
    });
});

describe('parsePlanBlock', () => {
    it('extracts numbered steps from a plan fence', () => {
        const text = [
            'Here is my plan:',
            '```plan',
            '1. Read the config',
            '2. Write the fix',
            '3. Run tests',
            '```',
        ].join('\n');
        expect(parsePlanBlock(text)).toEqual(['Read the config', 'Write the fix', 'Run tests']);
    });

    it('accepts dash bullets and unnumbered lines', () => {
        const text = ['```plan', '- step one', 'step two', '```'].join('\n');
        expect(parsePlanBlock(text)).toEqual(['step one', 'step two']);
    });

    it('returns empty for text without a plan block', () => {
        expect(parsePlanBlock('no plan here')).toEqual([]);
        expect(parsePlanBlock('```ts\nconst a = 1;\n```')).toEqual([]);
    });

    it('prefers the last plan block', () => {
        const text = [
            '```plan',
            '1. old',
            '```',
            'revised:',
            '```plan',
            '1. new',
            '```',
        ].join('\n');
        expect(parsePlanBlock(text)).toEqual(['new']);
    });
});

describe('PlanSnapshot round trip', () => {
    it('restores an identical machine from a snapshot', () => {
        const m = new PlanMachine();
        m.startPlanning();
        m.planProduced(['a', 'b']);
        m.approve();
        m.stepStarted(0);
        m.fail(0, 'rate limited');
        const snap: PlanSnapshot = m.snapshot();
        const restored = PlanMachine.fromSnapshot(snap);
        expect(restored.snapshot()).toEqual(snap);
        // And it keeps behaving.
        expect(restored.resume()).toBe(true);
        expect(restored.snapshot().phase).toBe('executing');
    });
});

describe('PLAN_READONLY_TOOLS', () => {
    it('excludes every write-class core tool', () => {
        for (const tool of ['bash', 'powershell', 'edit', 'write', 'edit-diff']) {
            expect(PLAN_READONLY_TOOLS).not.toContain(tool);
        }
        for (const tool of ['read', 'grep', 'find', 'ls']) {
            expect(PLAN_READONLY_TOOLS).toContain(tool);
        }
    });
});
