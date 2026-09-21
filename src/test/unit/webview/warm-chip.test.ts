// @vitest-environment happy-dom
//
// Exercises the REAL chat webview bootstrap (src/webview/main.ts) inside
// happy-dom with a mock `acquireVsCodeApi`. The cache-warming footer chip
// (SDK 0.86+) must appear in the composer footer when the state frame carries
// a warming status, and must be absent when it does not.

import { describe, it, expect, vi } from 'vitest';
import type { ServerMessage, CacheWarmingStatusInfo, CacheWarmingDecisionInfo } from '../../../shared/protocol';

// main.ts is a module-level singleton (webview state + window listeners live
// in module scope), so every test re-executes it via vi.resetModules().

interface ApiMock {
    postMessage: (m: any) => void;
    getState: () => unknown;
    setState: (s: unknown) => void;
}

function installHarness(
    status: CacheWarmingStatusInfo | undefined,
    decision: CacheWarmingDecisionInfo | undefined,
): ApiMock {
    document.body.innerHTML = '<div id="app"></div>';

    const snapshot: Record<string, unknown> = {
        sessionId: 's1',
        sessionName: 'Smoke',
        activeTabId: 't1',
        tabs: [{ id: 't1', name: 'Smoke', isActive: true, isStreaming: false, hasNotification: false }],
        messages: [] as any[],
        isStreaming: false,
        tools: [] as string[],
        model: { provider: 'anthropic', id: 'claude-smoke', name: 'Claude Smoke' },
        supportsImages: true,
        contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
    };
    if (status) snapshot.cacheWarmingStatus = status;
    if (decision) snapshot.cacheWarmingDecision = decision;

    const dispatch = (data: ServerMessage): void => {
        window.dispatchEvent(new MessageEvent('message', { data }));
    };

    const api: ApiMock = {
        postMessage: (m: any) => {
            if (m.type === 'getState') {
                setTimeout(() => dispatch({ type: 'stateSync', state: snapshot as any, images: {} }), 0);
            }
            if (m.type === 'getSkills') {
                setTimeout(() => dispatch({ type: 'skills', skills: [] }), 0);
            }
        },
        getState: () => undefined,
        setState: () => undefined,
    };

    (window as unknown as { acquireVsCodeApi?: () => ApiMock }).acquireVsCodeApi = () => api;
    return api;
}

async function nextFrame(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
}

describe('cache warming footer chip (real main.ts), ' + __filename.split(/[\\/]/).pop()!, () => {
    it('shows a warming chip with the per-refresh saving while a refresh runs', async () => {
        installHarness(
            { state: 'refreshing' },
            {
                phase: 'idle',
                warmCost: 0.02,
                missCost: 0.3,
                continuationProbability: 0.7,
                expectedSavings: 0.53,
                economicsAvailable: true,
                action: 'warm',
            },
        );

        vi.resetModules();
        await import('../../../webview/main');
        await nextFrame();
        await nextFrame();

        const chip = document.querySelector('.warm-chip');
        expect(chip).not.toBeNull();
        expect(chip?.textContent).toBe('warming…');
        expect(chip?.getAttribute('class')).toContain('warm-chip-active');
        expect(chip?.getAttribute('title')).toContain('$0.53');
    });

    it('renders the inactive pill when warming is off', async () => {
        installHarness({ state: 'inactive' }, undefined);

        vi.resetModules();
        await import('../../../webview/main');
        await nextFrame();
        await nextFrame();

        const chip = document.querySelector('.warm-chip');
        expect(chip, 'inactive status still renders a pill').not.toBeNull();
        expect(chip?.textContent).toBe('warm off');
        expect(chip?.getAttribute('class')).not.toContain('warm-chip-active');
    });

    it('renders no chip when the SDK does not expose cache warming', async () => {
        installHarness(undefined, undefined);

        vi.resetModules();
        await import('../../../webview/main');
        await nextFrame();
        await nextFrame();

        expect(document.querySelector('.warm-chip')).toBeNull();
    });
});