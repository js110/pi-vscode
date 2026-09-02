import { beforeAll, afterAll, vi } from 'vitest';
import type { AgentSession, ModelRegistry } from '@earendil-works/pi-coding-agent';

vi.mock('vscode', () => {
    const noop = () => undefined as any;
    const event = () => ({ fire: noop, dispose: noop } as any);
    return {
        workspace: {
            workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
            getConfiguration: () => ({ get: () => undefined, has: () => false, update: noop }),
            openTextDocument: async () => ({} as any),
            registerTextDocumentContentProvider: () => ({ dispose: noop }),
            onDidChangeConfiguration: event,
        },
        window: {
            createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show: noop, dispose: noop }),
            createWebviewPanel: noop,
            showInformationMessage: async () => undefined,
            showWarningMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            showTextDocument: async () => ({} as any),
            showQuickPick: async () => undefined,
        },
        commands: {
            executeCommand: async () => undefined,
            registerCommand: () => ({ dispose: noop }),
        },
        Uri: {
            file: (p: string) => ({ fsPath: p } as any),
            parse: (s: string) => ({ toString: () => s } as any),
            joinPath: (a: any, ...p: string[]) => ({ fsPath: [a?.fsPath, ...p].join('/') } as any),
        },
        EventEmitter: class { fire = noop; dispose = noop; event = noop; },
        Disposable: { from: () => ({ dispose: noop }) },
        StatusBarAlignment: { Left: 1, Right: 2 },
        ConfigurationTarget: { Global: 1 },
        ViewColumn: { One: 1 },
        env: {},
        version: '0.0.0',
    };
});

export let TEST_MODEL_PROVIDER = '';
export let TEST_MODEL_ID = '';

let _authStorage: any;
let _modelRegistry: ModelRegistry;
let _initialized = false;

export async function initTestInfra() {
    if (_initialized) { return { authStorage: _authStorage, modelRegistry: _modelRegistry }; }

    const { ModelRuntime, ModelRegistry } = await import('@earendil-works/pi-coding-agent');
    _authStorage = await ModelRuntime.create();
    _modelRegistry = new ModelRegistry(_authStorage);
    const testModel = _modelRegistry.getAvailable()[0];
    if (!testModel) { throw new Error('Pi has no available models for SDK tests'); }
    TEST_MODEL_PROVIDER = String(testModel.provider);
    TEST_MODEL_ID = testModel.id;
    _initialized = true;
    return { authStorage: _authStorage, modelRegistry: _modelRegistry };
}

export async function createTestSession(cwd?: string): Promise<AgentSession> {
    const { createAgentSession, SessionManager } = await import('@earendil-works/pi-coding-agent');
    const { authStorage, modelRegistry } = await initTestInfra();

    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-'));

    const sessionManager = SessionManager.create(tmpDir);
    const { session } = await createAgentSession({
        cwd: tmpDir,
        modelRuntime: authStorage,
        sessionManager,
    });

    const model = modelRegistry.find(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
    if (model) {
        await session.setModel(model);
    } else {
        console.warn(`Test model ${TEST_MODEL_PROVIDER}/${TEST_MODEL_ID} not found in registry, using default`);
    }

    return session;
}

export function getModelRegistry(): ModelRegistry {
    if (!_modelRegistry) { throw new Error('Call initTestInfra() first'); }
    return _modelRegistry;
}

beforeAll(async () => {
    await initTestInfra();
}, 30_000);

afterAll(() => {
    _initialized = false;
});
