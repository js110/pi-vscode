// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';

describe('editor context and compact view', () => {
    it('inserts the current file only on request and keeps tool activity expandable', async () => {
        document.body.innerHTML = '<div id="app"></div>';
        let saved: any;
        const posted: any[] = [];
        const dispatch = (data: ServerMessage) => window.dispatchEvent(new MessageEvent('message', { data }));
        (window as any).acquireVsCodeApi = () => ({
            getState: () => saved, setState: (value: any) => { saved = value; },
            postMessage: (message: any) => {
                posted.push(message);
                if (message.type === 'getState') setTimeout(() => dispatch({ type: 'stateSync', state: {
                    activeTabId: 't1', sessionId: 's1', messages: [
                        { role: 'user', content: 'hello' },
                        { role: 'toolResult', toolName: 'bash', toolCallId: 'tool1', content: [{ type: 'text', text: 'result' }] },
                    ], tools: [], isStreaming: false,
                } }), 0);
            },
        });
        await import('../../../webview/main');
        await new Promise(resolve => setTimeout(resolve, 120));
        dispatch({ type: 'editorFileChanged', path: '/other-root/src/file name.ts', displayPath: 'other-root/src/file name.ts' });
        const input = document.getElementById('input') as HTMLTextAreaElement;
        expect(input.value).toBe('');
        expect(document.getElementById('editor-file-chip')?.textContent).toContain('src/file name.ts');
        document.querySelector<HTMLButtonElement>('#editor-file-chip button')!.click();
        expect(input.value).toContain('"/other-root/src/file name.ts"');

        document.getElementById('btn-focus-view')!.click();
        await new Promise(resolve => setTimeout(resolve, 60));
        const folded = document.querySelector<HTMLDetailsElement>('#messages > .focus-activity');
        expect(saved.focusView).toBe(true);
        expect(folded?.open).toBe(false);
        expect(folded?.querySelector('.tool-card')).not.toBeNull();
        folded!.open = true;
        expect(folded!.open).toBe(true);
        dispatch({ type: 'agentEvent', event: { type: 'agent_start' } });
        dispatch({ type: 'agentEvent', event: { type: 'tool_execution_start', toolCallId: 'live', toolName: 'read', args: { path: '/a' } } });
        const liveFold = document.querySelector<HTMLDetailsElement>('#streaming-message > .focus-activity');
        expect(liveFold?.open).toBe(false);
        expect(liveFold?.querySelector('#tool-live')).not.toBeNull();
        dispatch({ type: 'agentEvent', event: { type: 'message_start', message: { role: 'assistant' } } });
        dispatch({ type: 'agentEvent', event: { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } } });
        dispatch({ type: 'agentEvent', event: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' } } });
        await new Promise(resolve => setTimeout(resolve, 60));
        expect((document.getElementById('streaming-thinking') as HTMLDetailsElement).open).toBe(false);
        document.getElementById('btn-focus-view')!.click();
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(document.querySelector('#messages > .focus-activity')).toBeNull();
        expect(document.querySelector('#messages > .tool-card-wrapper')).not.toBeNull();
        expect(document.querySelector('#streaming-message > #tool-live')).not.toBeNull();
        expect(posted.some(message => message.type === 'prompt')).toBe(false);
    });
});
