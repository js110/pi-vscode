import { describe, it, expect, vi } from 'vitest';
import {
    buildConfigSnapshot,
    deriveConfigStatus,
    discoverPiConfig,
    type ConfigDiscoveryDeps,
    type DiscoveryInputs,
} from '../../../pi/config';
import type { PiConfigSnapshot } from '../../../shared/protocol';

function makeInputs(over: Partial<DiscoveryInputs> = {}): DiscoveryInputs {
    return {
        agentDir: '/home/u/.pi/agent',
        agentDirExists: true,
        models: [
            { provider: 'deepseek', id: 'deepseek-chat' },
            { provider: 'deepseek', id: 'deepseek-flash' },
            { provider: 'openai', id: 'gpt-5' },
        ],
        skills: [
            { name: 's1', description: '', filePath: '/p/s1', source: 'user', disableModelInvocation: false },
        ],
        errors: [],
        ...over,
    };
}

const PREV: PiConfigSnapshot = {
    status: 'ok',
    agentDir: '/home/u/.pi/agent',
    agentDirExists: true,
    providers: ['deepseek', 'openai'],
    models: [
        { provider: 'deepseek', id: 'deepseek-chat' },
        { provider: 'deepseek', id: 'deepseek-flash' },
        { provider: 'openai', id: 'gpt-5' },
    ],
    skills: [
        { name: 's1', description: '', filePath: '/p/s1', source: 'user', disableModelInvocation: false },
    ],
    errors: [],
    discoveredAt: 1_000,
};

describe('deriveConfigStatus', () => {
    it('returns ok when every source succeeds', () => {
        expect(deriveConfigStatus(makeInputs())).toBe('ok');
    });

    it('returns not-found when the agent dir is missing, overriding other results', () => {
        const inputs = makeInputs({ agentDirExists: false, models: null, skills: null });
        expect(deriveConfigStatus(inputs)).toBe('not-found');
    });

    it('returns partial when one source fails', () => {
        const inputs = makeInputs({ models: null });
        expect(deriveConfigStatus(inputs)).toBe('partial');
    });

    it('returns error when all sources fail', () => {
        const inputs = makeInputs({ models: null, skills: null });
        expect(deriveConfigStatus(inputs)).toBe('error');
    });

    it('returns partial when errors were recorded even if sources succeeded', () => {
        const inputs = makeInputs({
            errors: [{ source: 'models', message: 'degraded' }],
        });
        expect(deriveConfigStatus(inputs)).toBe('partial');
    });
});

describe('buildConfigSnapshot', () => {
    it('computes distinct sorted providers from models', () => {
        const snap = buildConfigSnapshot(undefined, makeInputs(), 5_000);
        expect(snap.providers).toEqual(['deepseek', 'openai']);
    });

    it('keeps the previous model list when the models source fails (PRD 6.3)', () => {
        const inputs = makeInputs({
            models: null,
            errors: [{ source: 'models', message: 'models.json parse error' }],
        });
        const snap = buildConfigSnapshot(PREV, inputs, 5_000);
        expect(snap.models).toEqual(PREV.models);
        expect(snap.status).toBe('partial');
        expect(snap.errors).toEqual([{ source: 'models', message: 'models.json parse error' }]);
    });

    it('keeps the previous skill list when the skills source fails', () => {
        const inputs = makeInputs({
            skills: null,
            errors: [{ source: 'skills', message: 'skills dir unreadable' }],
        });
        const snap = buildConfigSnapshot(PREV, inputs, 5_000);
        expect(snap.skills).toEqual(PREV.skills);
        expect(snap.status).toBe('partial');
    });

    it('falls back to empty lists when a source fails with no previous snapshot', () => {
        const snap = buildConfigSnapshot(undefined, makeInputs({ models: null }), 5_000);
        expect(snap.models).toEqual([]);
        expect(snap.providers).toEqual([]);
    });

    it('does not mutate the previous snapshot', () => {
        const before = JSON.parse(JSON.stringify(PREV)) as PiConfigSnapshot;
        buildConfigSnapshot(PREV, makeInputs({ models: null, skills: null }), 5_000);
        expect(PREV).toEqual(before);
    });

    it('records agent dir and timestamp', () => {
        const snap = buildConfigSnapshot(PREV, makeInputs(), 42_000);
        expect(snap.agentDir).toBe('/home/u/.pi/agent');
        expect(snap.agentDirExists).toBe(true);
        expect(snap.discoveredAt).toBe(42_000);
    });

    it('flags not-found status through to the snapshot', () => {
        const snap = buildConfigSnapshot(PREV, makeInputs({ agentDirExists: false, models: null, skills: null }), 5_000);
        expect(snap.status).toBe('not-found');
    });
});

describe('discoverPiConfig', () => {
    function makeDeps(over: Partial<ConfigDiscoveryDeps> = {}): ConfigDiscoveryDeps {
        return {
            agentDir: vi.fn(async () => '/home/u/.pi/agent'),
            dirExists: vi.fn(() => true),
            models: vi.fn(async () => makeInputs().models!),
            skills: vi.fn(async () => makeInputs().skills!),
            now: vi.fn(() => 7_000),
            ...over,
        };
    }

    it('returns an ok snapshot when discovery succeeds', async () => {
        const deps = makeDeps();
        const snap = await discoverPiConfig('/work', deps);
        expect(snap.status).toBe('ok');
        expect(snap.providers).toEqual(['deepseek', 'openai']);
        expect(snap.discoveredAt).toBe(7_000);
        expect(deps.models).toHaveBeenCalledOnce();
        expect(deps.skills).toHaveBeenCalledWith('/work');
    });

    it('reports not-found and skips source queries when the dir is missing', async () => {
        const deps = makeDeps({ dirExists: vi.fn(() => false) });
        const snap = await discoverPiConfig('/work', deps);
        expect(snap.status).toBe('not-found');
        expect(snap.agentDirExists).toBe(false);
        expect(deps.models).not.toHaveBeenCalled();
        expect(deps.skills).not.toHaveBeenCalled();
        expect(snap.errors[0]?.source).toBe('agentDir');
    });

    it('captures a models failure as an issue and keeps the previous list', async () => {
        const deps = makeDeps({
            models: vi.fn(async () => { throw new Error('auth.json is not valid JSON'); }),
        });
        const snap = await discoverPiConfig('/work', deps, PREV);
        expect(snap.status).toBe('partial');
        expect(snap.models).toEqual(PREV.models);
        expect(snap.errors).toEqual([
            { source: 'models', message: 'auth.json is not valid JSON' },
        ]);
    });

    it('reports error when both sources fail', async () => {
        const deps = makeDeps({
            models: vi.fn(async () => { throw new Error('boom'); }),
            skills: vi.fn(async () => { throw new Error('bang'); }),
        });
        const snap = await discoverPiConfig('/work', deps);
        expect(snap.status).toBe('error');
        expect(snap.errors.map((e) => e.source)).toEqual(['models', 'skills']);
    });
});
