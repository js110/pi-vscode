import { describe, it, expect, vi } from 'vitest';
import {
    ApprovalMemory,
    isDangerousTool,
    type ApprovalRuleInfo,
    type GlobalRuleStore,
} from '../../../pi/approval-memory';

function makeStore(initial: ApprovalRuleInfo[] = []): GlobalRuleStore & { saved: ApprovalRuleInfo[][] } {
    let rules = initial.map((r) => ({ ...r }));
    const saved: ApprovalRuleInfo[][] = [];
    return {
        load: vi.fn(() => rules.map((r) => ({ ...r }))),
        save: vi.fn((next: ApprovalRuleInfo[]) => {
            rules = next.map((r) => ({ ...r }));
            saved.push(next);
        }),
        saved,
    };
}

describe('isDangerousTool', () => {
    it('flags shell-execution tools', () => {
        expect(isDangerousTool('bash')).toBe(true);
        expect(isDangerousTool('powershell')).toBe(true);
        expect(isDangerousTool('someShell')).toBe(true);
    });

    it('does not flag ordinary read/write tools', () => {
        expect(isDangerousTool('read')).toBe(false);
        expect(isDangerousTool('write')).toBe(false);
        expect(isDangerousTool('edit')).toBe(false);
        expect(isDangerousTool('openDiff')).toBe(false);
    });

    it('is case-insensitive and tolerates non-string input', () => {
        expect(isDangerousTool('BASH')).toBe(true);
        expect(isDangerousTool(undefined as any)).toBe(false);
    });
});

describe('ApprovalMemory', () => {
    it('prompts for unknown tools', () => {
        const memory = new ApprovalMemory(makeStore());
        expect(memory.check('write')).toEqual({ approved: false });
    });

    it('auto-approves a remembered session rule', () => {
        const memory = new ApprovalMemory(makeStore());
        memory.remember('write', 'session');
        expect(memory.check('write')).toEqual({ approved: true, scope: 'session' });
    });

    it('auto-approves a remembered global rule', () => {
        const store = makeStore();
        const memory = new ApprovalMemory(store);
        memory.remember('find', 'global');
        expect(memory.check('find')).toEqual({ approved: true, scope: 'global' });
        expect(store.saved.length).toBe(1);
    });

    it('never auto-approves dangerous tools, even if a rule exists', () => {
        const store = makeStore([{ tool: 'bash', createdAt: 1 }]);
        const memory = new ApprovalMemory(store);
        expect(memory.check('bash')).toEqual({ approved: false });
        memory.remember('bash', 'global');
        memory.remember('bash', 'session');
        expect(memory.check('bash')).toEqual({ approved: false });
        expect(store.saved.length).toBe(0);
    });

    it('keeps session rules private to the instance (per-tab isolation)', () => {
        const store = makeStore();
        const tabA = new ApprovalMemory(store);
        const tabB = new ApprovalMemory(store);
        tabA.remember('write', 'session');
        expect(tabA.check('write').approved).toBe(true);
        expect(tabB.check('write').approved).toBe(false);
    });

    it('shares global rules between instances through the store', () => {
        const store = makeStore();
        const tabA = new ApprovalMemory(store);
        const tabB = new ApprovalMemory(store);
        tabA.remember('grep', 'global');
        expect(tabB.check('grep')).toEqual({ approved: true, scope: 'global' });
    });

    it('deduplicates repeated remembers for the same tool', () => {
        const memory = new ApprovalMemory(makeStore());
        memory.remember('read', 'session');
        memory.remember('read', 'session');
        expect(memory.listSessionRules().length).toBe(1);
    });

    it('revokes a global rule immediately', () => {
        const store = makeStore([{ tool: 'write', createdAt: 1 }]);
        const memory = new ApprovalMemory(store);
        expect(memory.check('write').approved).toBe(true);
        memory.revokeGlobal('write');
        expect(memory.check('write').approved).toBe(false);
    });

    it('clears all global rules', () => {
        const store = makeStore([
            { tool: 'write', createdAt: 1 },
            { tool: 'grep', createdAt: 2 },
        ]);
        const memory = new ApprovalMemory(store);
        memory.clearGlobal();
        expect(memory.check('write').approved).toBe(false);
        expect(memory.check('grep').approved).toBe(false);
    });

    it('matches tool names case-insensitively', () => {
        const memory = new ApprovalMemory(makeStore());
        memory.remember('Write', 'session');
        expect(memory.check('write').approved).toBe(true);
        expect(memory.check('WRITE').approved).toBe(true);
    });

    it('does not expose mutable internal session state', () => {
        const memory = new ApprovalMemory(makeStore());
        memory.remember('read', 'session');
        const listed = memory.listSessionRules();
        listed.push({ tool: 'bash', createdAt: 0 });
        expect(memory.check('bash').approved).toBe(false);
    });
});
