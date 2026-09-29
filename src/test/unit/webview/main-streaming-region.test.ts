// @vitest-environment happy-dom
//
// Exercises the REAL chat webview bootstrap (src/webview/main.ts) inside
// happy-dom with a mock `acquireVsCodeApi`, driving agent events the way the
// extension host does. Guards the live assistant bubble:
//   - one bubble per assistant message (text must not accumulate across the
//     several messages a single run emits, e.g. tool calls and auto-retries),
//   - a finished message is not rendered twice,
//   - tool cards of the run survive and stay above the running bubble,
//   - the thinking block collapses once the model starts answering.
//
// One test, sequential phases: main.ts installs a `window` message listener on
// import, and ESM caches the module, so a second import would neither re-run
// init nor isolate state. Phases run back to back inside a single run, which
// is also the shape the host actually produces.

import { describe, it, expect } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

function installHarness(): { dispatch: (m: ServerMessage) => void } {
    document.body.innerHTML = '<div id="app"></div>';

    const snapshot = {
        sessionId: 's1',
        sessionName: 'Smoke',
        activeTabId: 't1',
        tabs: [{ id: 't1', name: 'Smoke', isActive: true, isStreaming: false, hasNotification: false }],
        messages: [] as any[],
        isStreaming: false,
        tools: [] as string[],
        model: { provider: 'anthropic', id: 'claude-smoke', name: 'Claude Smoke' },
        supportsImages: true,
    };

    const dispatch = (m: ServerMessage): void => {
        window.dispatchEvent(new MessageEvent('message', { data: m }));
    };

    const api = {
        postMessage: (m: any) => {
            if (m.type === 'getState') {
                setTimeout(() => dispatch({ type: 'stateSync', state: snapshot, images: {} }), 0);
            }
            if (m.type === 'getSkills') {
                setTimeout(() => dispatch({ type: 'skills', skills: [] }), 0);
            }
        },
        getState: () => undefined,
        setState: () => undefined,
    };

    (window as unknown as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => api;
    return { dispatch };
}

async function nextFrame(): Promise<void> {
    await new Promise((r) => setTimeout(r, 30));
}

const event = (e: any): ServerMessage => ({ type: 'agentEvent', event: e } as ServerMessage);
const delta = (d: string): ServerMessage =>
    event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: d } });
const thinkingStart = (): ServerMessage =>
    event({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } });
const thinkingDelta = (d: string): ServerMessage =>
    event({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: d } });
const thinkingEnd = (): ServerMessage =>
    event({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } });

function liveRegion(): HTMLElement {
    const el = document.getElementById('streaming-message');
    expect(el, 'live streaming region should be mounted').not.toBeNull();
    return el as HTMLElement;
}

function liveText(): string {
    return document.getElementById('streaming-text')?.textContent ?? '';
}

function childIndex(pred: (el: Element) => boolean): number {
    return Array.from(liveRegion().children).findIndex(pred);
}

describe('live streaming region (real main.ts), ' + __filename.split(/[\\/]/).pop()!, () => {
    it('keeps one bubble per assistant message, preserves tool cards, collapses thinking', async () => {
        const { dispatch } = installHarness();
        await import('../../../webview/main');
        await nextFrame();
        await nextFrame();

        // ── phase 1: first assistant message of a run ──
        dispatch(event({ type: 'agent_start' }));
        dispatch(event({ type: 'message_start', message: { role: 'assistant' } }));
        dispatch(thinkingStart());
        dispatch(thinkingDelta('weighing options'));
        dispatch(delta('let me look'));
        await nextFrame();

        const thinkingEl = document.getElementById('streaming-thinking') as HTMLDetailsElement;
        expect(thinkingEl, 'thinking block should be live').not.toBeNull();
        expect(thinkingEl.open, 'thinking is expanded while the model thinks').toBe(true);
        expect(thinkingEl.textContent).toContain('weighing options');
        expect(liveText()).toContain('let me look');

        // ── phase 2: thinking ends, the same message keeps streaming text ──
        dispatch(thinkingEnd());
        dispatch(delta('here it is'));
        await nextFrame();
        expect(thinkingEl.open, 'thinking collapses once the model answers').toBe(false);
        expect(thinkingEl.textContent).toContain('weighing options');
        expect(liveText()).toContain('here it is');

        // ── phase 3: tool call inside the same run ──
        dispatch(
            event({
                type: 'tool_execution_start',
                toolCallId: 'tc-1',
                toolName: 'read',
                args: { path: '/work/a.ts' },
            }),
        );
        await nextFrame();
        expect(document.getElementById('tool-tc-1'), 'tool card should render').not.toBeNull();

        // ── phase 4: second assistant message — the previous answer is in the
        // transcript, so the bubble must start empty and keep the tool card ──
        dispatch(event({ type: 'message_start', message: { role: 'assistant' } }));
        dispatch(delta('now the summary'));
        await nextFrame();

        expect(liveText(), 'previous answer must not bleed into the new bubble').not.toContain('here it is');
        expect(liveText()).toContain('now the summary');
        expect(document.getElementById('tool-tc-1'), 'tool card survives the new message').not.toBeNull();
        expect(
            childIndex((el) => el.classList.contains('message')),
            'running bubble trails the tool card',
        ).toBe(childIndex((el) => el.id === 'tool-tc-1') + 1);

        // ── phase 5: message_end stands the bubble down (no double render) ──
        dispatch(event({ type: 'message_end', message: { role: 'assistant' } }));
        await nextFrame();
        expect(liveText()).not.toContain('now the summary');

        // ── phase 6: the settled run tears the region down ──
        dispatch(event({ type: 'agent_end' }));
        dispatch(event({ type: 'agent_settled' }));
        await nextFrame();
        expect(liveRegion().children.length).toBe(0);
    });
});
