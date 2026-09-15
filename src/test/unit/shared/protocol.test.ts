import { describe, it, expect } from 'vitest';
import type {
    ClientMessage,
    ServerMessage,
    SerializedAgentState,
    SettingsClientMessage,
    SettingsServerMessage,
} from '../../../shared/protocol';

describe('Protocol types', () => {
    it('client messages serialize correctly', () => {
        const messages: ClientMessage[] = [
            { type: 'prompt', text: 'hello' },
            { type: 'abort' },
            { type: 'setModel', provider: 'ollama', modelId: 'test/model' },
            { type: 'setThinkingLevel', level: 'high' },
            { type: 'newSession' },
            { type: 'getModels' },
            { type: 'getSessions' },
            { type: 'getState' },
            { type: 'refreshConfig' },
            { type: 'rememberToolApproval', toolCallId: 't1', scope: 'session' },
        ];

        for (const msg of messages) {
            const serialized = JSON.stringify(msg);
            const deserialized = JSON.parse(serialized) as ClientMessage;
            expect(deserialized.type).toBe(msg.type);
        }
    });

    it('server messages serialize correctly', () => {
        const state: SerializedAgentState = {
            messages: [{ role: 'user', content: 'hello' }],
            isStreaming: false,
            tools: ['bash', 'read', 'write', 'edit'],
            sessionId: 'test-id',
            model: { provider: 'ollama', id: 'test/model', name: 'Test Model' },
            thinkingLevel: 'off',
        };

        const messages: ServerMessage[] = [
            { type: 'ready' },
            { type: 'stateSync', state },
            { type: 'error', message: 'something went wrong' },
            { type: 'models', models: [{ provider: 'ollama', id: 'test', name: 'Test' }] },
            {
                type: 'configState',
                config: {
                    status: 'ok',
                    agentDir: '/home/u/.pi/agent',
                    agentDirExists: true,
                    providers: ['ollama'],
                    models: [{ provider: 'ollama', id: 'test' }],
                    skills: [],
                    errors: [],
                    discoveredAt: 0,
                },
            },
            { type: 'approvalTrace', toolCallId: 't2', toolName: 'write', scope: 'global' },
        ];

        for (const msg of messages) {
            const roundTripped = JSON.parse(JSON.stringify(msg)) as ServerMessage;
            expect(roundTripped.type).toBe(msg.type);
        }
    });

    it('state with streaming message serializes', () => {
        const state: SerializedAgentState = {
            messages: [],
            isStreaming: true,
            streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'streaming...' }] },
            tools: [],
        };

        const msg: ServerMessage = { type: 'stateSync', state };
        const parsed = JSON.parse(JSON.stringify(msg));
        expect(parsed.state.isStreaming).toBe(true);
        expect(parsed.state.streamingMessage).toBeDefined();
    });

    it('settings messages for approval rules serialize correctly', () => {
        const clientMessages: SettingsClientMessage[] = [
            { type: 'getApprovalRules' },
            { type: 'revokeApprovalRule', tool: 'write' },
            { type: 'clearApprovalRules' },
        ];
        for (const msg of clientMessages) {
            const roundTripped = JSON.parse(JSON.stringify(msg)) as SettingsClientMessage;
            expect(roundTripped.type).toBe(msg.type);
        }

        const serverMessages: SettingsServerMessage[] = [
            { type: 'approvalRules', rules: [{ tool: 'write', createdAt: 1_000 }] },
        ];
        for (const msg of serverMessages) {
            const roundTripped = JSON.parse(JSON.stringify(msg)) as SettingsServerMessage;
            expect(roundTripped.type).toBe(msg.type);
        }
    });

    it('apply preview/confirm messages serialize correctly', () => {
        const clientMessages: ClientMessage[] = [
            { type: 'applyPreview', code: 'const a = 1;', lang: 'ts' },
            { type: 'applyConfirm', previewId: 'ap-1' },
            { type: 'applyCancel', previewId: 'ap-1' },
        ];
        for (const msg of clientMessages) {
            const roundTripped = JSON.parse(JSON.stringify(msg)) as ClientMessage;
            expect(roundTripped.type).toBe(msg.type);
        }

        const preview: ServerMessage = {
            type: 'applyPreviewResult',
            preview: {
                previewId: 'ap-1',
                targetPath: '/w/src/a.ts',
                isNew: false,
                diff: '-old\n+new',
                addedLines: 1,
                removedLines: 1,
                code: 'new',
            },
        };
        const roundTripped = JSON.parse(JSON.stringify(preview)) as ServerMessage;
        expect(roundTripped.type).toBe('applyPreviewResult');
        if (roundTripped.type === 'applyPreviewResult') {
            expect(roundTripped.preview.targetPath).toBe('/w/src/a.ts');
            expect(roundTripped.preview.isNew).toBe(false);
        }

        const result: ServerMessage = { type: 'applyResult', previewId: 'ap-1', ok: true };
        expect(JSON.parse(JSON.stringify(result)).ok).toBe(true);
    });
});
