// @vitest-environment happy-dom
//
// The webview shell is rebuilt by render() on every tab switch and language
// change, but document-level listeners must survive exactly one registration:
// stacking them means N clipboard writes and N quote captures per keystroke.
// This file installs a counting spy before importing main.ts, so it can assert
// the registration count directly instead of inferring it from side effects.

import { describe, it, expect, beforeAll } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

const registrations: { type: string; capture: boolean }[] = [];

const dispatch = (m: ServerMessage) => window.dispatchEvent(new MessageEvent('message', { data: m }));
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

function stateSync(activeTabId: string): ServerMessage {
    return {
        type: 'stateSync',
        state: {
            sessionId: 's1',
            sessionName: 'Listeners',
            activeTabId,
            tabs: [
                { id: 't1', name: 'One', isActive: activeTabId === 't1', isStreaming: false, hasNotification: false },
                { id: 't2', name: 'Two', isActive: activeTabId === 't2', isStreaming: false, hasNotification: false },
            ],
            messages: [],
            tools: [],
            isStreaming: false,
        },
    } as ServerMessage;
}

const count = (type: string) => registrations.filter(r => r.type === type).length;

beforeAll(async () => {
    const original = document.addEventListener.bind(document);
    document.addEventListener = ((type: string, listener: any, options?: any) => {
        registrations.push({ type, capture: typeof options === 'boolean' ? options : !!options?.capture });
        return original(type, listener, options);
    }) as typeof document.addEventListener;

    document.body.innerHTML = '<div id="app"></div>';
    (window as any).acquireVsCodeApi = () => ({
        getState: () => undefined,
        setState: () => undefined,
        postMessage: (message: any) => {
            if (message.type === 'getState') setTimeout(() => dispatch(stateSync('t1')), 0);
        },
    });

    await import('../../../webview/main');
    await pause();
});

describe('document-level listener registration', () => {
    it('registers the copy/keydown/selection hooks once even after several renders', async () => {
        const baseline = {
            copy: count('copy'),
            keydown: count('keydown'),
            selectionchange: count('selectionchange'),
            pointerdown: count('pointerdown'),
            pointerup: count('pointerup'),
        };
        expect(baseline.copy).toBe(1);
        expect(baseline.selectionchange).toBe(1);
        expect(baseline.pointerup).toBe(1);

        // Each of these runs render() on the webview side.
        dispatch(stateSync('t2'));
        await pause();
        dispatch(stateSync('t1'));
        await pause();
        dispatch({ type: 'langChanged', lang: 'zh' } as ServerMessage);
        await pause();
        dispatch({ type: 'langChanged', lang: 'en' } as ServerMessage);
        await pause();

        expect(count('copy')).toBe(baseline.copy);
        expect(count('keydown')).toBe(baseline.keydown);
        expect(count('selectionchange')).toBe(baseline.selectionchange);
        expect(count('pointerup')).toBe(baseline.pointerup);
        // pointerdown legitimately appears more than once (the transcript-mark
        // guard and the quote capture are separate concerns) but must not grow.
        expect(count('pointerdown')).toBe(baseline.pointerdown);
    });
});
