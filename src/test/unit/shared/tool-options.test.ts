import { describe, it, expect } from 'vitest';
import { buildSessionToolOptions } from '../../../shared/tool-options';

const base = {
    allowedTools: [] as string[],
    excludeTools: [] as string[],
    enableCodemode: false,
    enableToolSearch: false,
};

describe('buildSessionToolOptions', () => {
    it('passes nothing through when every setting is empty/off', () => {
        const opts = buildSessionToolOptions({ ...base });
        expect(opts.tools).toBeUndefined();
        expect(opts.excludeTools).toBeUndefined();
        expect(opts.skippedExtras).toEqual([]);
    });

    it('enables codemode/tool_search as delta entries when allowedTools is empty', () => {
        const opts = buildSessionToolOptions({ ...base, enableCodemode: true, enableToolSearch: true });
        expect(opts.tools).toEqual(['+codemode', '+tool_search']);
    });

    it('appends delta toggles onto a delta-style allowlist', () => {
        const opts = buildSessionToolOptions({
            ...base,
            allowedTools: ['-write'],
            enableCodemode: true,
        });
        expect(opts.tools).toEqual(['-write', '+codemode']);
    });

    it('never mixes delta entries into a plain allowlist (SDK throws on that)', () => {
        const opts = buildSessionToolOptions({
            ...base,
            allowedTools: ['read', 'bash'],
            enableCodemode: true,
            enableToolSearch: true,
        });
        expect(opts.tools).toEqual(['read', 'bash']);
        expect(opts.skippedExtras).toEqual(['+codemode', '+tool_search']);
    });

    it('does not duplicate a toggle the allowlist already lists by name', () => {
        const opts = buildSessionToolOptions({
            ...base,
            allowedTools: ['codemode', 'read'],
            enableCodemode: true,
        });
        expect(opts.tools).toEqual(['codemode', 'read']);
        expect(opts.skippedExtras).toEqual([]);
    });

    it('keeps an explicit delta entry from being appended twice', () => {
        const opts = buildSessionToolOptions({
            ...base,
            allowedTools: ['+codemode'],
            enableCodemode: true,
        });
        expect(opts.tools).toEqual(['+codemode']);
        expect(opts.skippedExtras).toEqual([]);
    });

    it('trims and drops empty entries in both lists', () => {
        const opts = buildSessionToolOptions({
            ...base,
            allowedTools: [' read ', '', 'bash'],
            excludeTools: [' ', 'mcp__github__*'],
        });
        expect(opts.tools).toEqual(['read', 'bash']);
        expect(opts.excludeTools).toEqual(['mcp__github__*']);
    });

    it('omits excludeTools when the denylist is empty', () => {
        const opts = buildSessionToolOptions({ ...base, excludeTools: ['', '  '] });
        expect(opts.excludeTools).toBeUndefined();
    });
});
