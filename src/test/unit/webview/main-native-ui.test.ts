// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import type { ServerMessage, SerializedAgentState } from '../../../shared/protocol';

it('wires tree navigation, extension dialogs, MCP keys and tab isolation through real main.ts', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const sent: any[] = [];
    const dispatch = (message: ServerMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
    const base: SerializedAgentState = { isStreaming: false, messages: [], tools: [], sessionId: 's1', activeTabId: 't1', tabs: [{ id: 't1', name: 'One', isActive: true, isStreaming: false, hasNotification: false }] };
    (window as any).acquireVsCodeApi = () => ({ postMessage: (message: any) => {
        sent.push(message);
        if (message.type === 'getState') setTimeout(() => dispatch({ type: 'stateSync', state: base }), 0);
    }, getState: () => undefined, setState: () => {} });
    await import('../../../webview/main');
    await vi.waitFor(() => expect(document.getElementById('btn-tree')).not.toBeNull());
    dispatch({ type: 'stateSync', state: base });
    document.getElementById('btn-tree')!.click();
    expect(sent).toContainEqual({ type: 'getSessionTree' });
    dispatch({ type: 'sessionTree', tabId: 't1', entries: [{ id: 'branch', parentId: null, depth: 0, kind: 'user', text: 'Draft', current: false }] });
    document.querySelector<HTMLButtonElement>('.tree-navigate')!.click();
    expect(sent).toContainEqual({ type: 'navigateSessionTree', entryId: 'branch', summarize: false, instructions: undefined });

    dispatch({ type: 'stateSync', state: { ...base, extensionUi: { statuses: { native: 'Connected' }, widgets: {}, dialog: { id: 'confirm', kind: 'confirm', title: 'Proceed?' } } } });
    document.querySelector<HTMLButtonElement>('#extension-dialog [data-action=accept]')!.click();
    expect(sent).toContainEqual({ type: 'extensionUiResponse', id: 'confirm', value: 'yes', cancelled: undefined });
    dispatch({ type: 'stateSync', state: { ...base, extensionUi: { statuses: {}, widgets: {}, custom: { id: 'mcp', title: 'MCP', lines: ['→ example: connected'] } } } });
    const custom = document.getElementById('extension-custom')!;
    custom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(sent.some(message => message.type === 'extensionUiInput' && message.id === 'mcp' && message.data === '\x1b[B')).toBe(true);
    expect(custom.querySelector('pre')!.textContent).toContain('connected');
    const event = (value: any) => dispatch({ type: 'agentEvent', event: value });
    event({ type: 'agent_start' });
    event({ type: 'tool_execution_start', toolName: 'codemode', toolCallId: 'parent', args: { code: 'text("output")' } });
    event({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'child', parentToolCallId: 'parent', args: { path: 'example' } });
    expect(document.querySelector('#tool-parent .nested-tools #tool-child')).not.toBeNull();
    event({ type: 'tool_execution_end', toolName: 'read', toolCallId: 'child', parentToolCallId: 'parent', durationMs: 15, result: { content: [{ type: 'text', text: 'nested result' }] } });
    event({ type: 'tool_execution_end', toolName: 'codemode', toolCallId: 'parent', durationMs: 2000, result: { content: [{ type: 'text', text: 'output' }, { type: 'image', data: 'aA==', mimeType: 'image/png' }], details: { calls: [{ name: 'read', status: 'ok', args: '{}', durationMs: 15 }] } } });
    expect(document.querySelector('#tool-parent img')).not.toBeNull();
    expect(document.querySelector('#tool-parent .nested-tools #tool-child')).not.toBeNull();
    expect(document.querySelector('#tool-parent .tool-duration')!.textContent).toBe('2.0 s');
    dispatch({ type: 'stateSync', state: { ...base, sessionId: 's2', activeTabId: 't2', runOutcome: 'cancelled', extensionUi: { statuses: {}, widgets: {} } } });
    expect(document.getElementById('extension-custom')).toBeNull();
    expect(document.getElementById('tree-panel')).toBeNull();
    expect(document.getElementById('extension-status')!.textContent).toContain('Cancelled');
    const input = document.querySelector<HTMLTextAreaElement>('#input')!;
    input.value = 'B draft';
    dispatch({ type: 'composerText', tabId: 't1', text: 'A navigation draft' });
    expect(input.value).toBe('B draft');
    dispatch({ type: 'stateSync', state: base });
    expect(document.querySelector<HTMLTextAreaElement>('#input')!.value).toBe('A navigation draft');
    dispatch({ type: 'stateSync', state: { ...base, activeTabId: 't2', sessionId: 's2' } });
    expect(document.querySelector<HTMLTextAreaElement>('#input')!.value).toBe('B draft');
    dispatch({ type: 'sessionTree', tabId: 't2', entries: [{ id: 'old', parentId: null, depth: 0, kind: 'user', text: 'Old session', current: false }] });
    expect(document.getElementById('tree-panel')).not.toBeNull();
    dispatch({ type: 'stateSync', state: { ...base, activeTabId: 't2', sessionId: 'replacement' } });
    expect(document.getElementById('tree-panel')).toBeNull();
});
