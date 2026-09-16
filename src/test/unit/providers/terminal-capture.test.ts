import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TerminalCapture } from '../../../providers/terminal-capture';
import { TERMINAL_OUTPUT_MAX_CHARS, type TerminalOutputEntry } from '../../../shared/terminal-quote';

const h = vi.hoisted(() => ({
    startCbs: [] as ((e: any) => void)[],
    endCbs: [] as ((e: any) => void)[],
    closeCbs: [] as ((t: any) => void)[],
}));

vi.mock('vscode', () => ({
    window: {
        onDidStartTerminalShellExecution: (cb: any) => {
            h.startCbs.push(cb);
            return {
                dispose: () => {
                    const i = h.startCbs.indexOf(cb);
                    if (i >= 0) h.startCbs.splice(i, 1);
                },
            };
        },
        onDidEndTerminalShellExecution: (cb: any) => {
            h.endCbs.push(cb);
            return {
                dispose: () => {
                    const i = h.endCbs.indexOf(cb);
                    if (i >= 0) h.endCbs.splice(i, 1);
                },
            };
        },
        onDidCloseTerminal: (cb: any) => {
            h.closeCbs.push(cb);
            return {
                dispose: () => {
                    const i = h.closeCbs.indexOf(cb);
                    if (i >= 0) h.closeCbs.splice(i, 1);
                },
            };
        },
    },
}));

type Deferred = { push: (chunk: string) => void; end: () => void };

function makeExecution(chunks: string[]): { execution: any; input: Deferred } {
    const queue = [...chunks];
    const wake: (() => void)[] = [];
    const done = { value: false };
    const flush = (): Promise<void> =>
        new Promise((resolve) => {
            if (queue.length > 0 || done.value) resolve();
            else wake.push(resolve);
        });
    const execution = {
        commandLine: { value: 'npm test', confidence: 2, isTrusted: true },
        cwd: undefined,
        async *read() {
            for (;;) {
                while (queue.length > 0) {
                    yield queue.shift();
                }
                if (done.value) return;
                await flush();
            }
        },
    };
    return {
        execution,
        input: {
            push: (chunk) => {
                queue.push(chunk);
                wake.splice(0).forEach((fn) => fn());
            },
            end: () => {
                done.value = true;
                wake.splice(0).forEach((fn) => fn());
            },
        },
    };
}

function makeTerminal(name: string): any {
    return { name, sendText: vi.fn(), show: vi.fn() };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function endRun(terminal: any, execution: any): void {
    h.endCbs.forEach((cb) => cb({ terminal, execution, exitCode: 0 }));
}

describe('TerminalCapture', () => {
    let capture: TerminalCapture;

    beforeEach(() => {
        h.startCbs = [];
        h.endCbs = [];
        h.closeCbs = [];
        capture = new TerminalCapture();
    });

    it('captures the output of a completed command, stripped of escapes', async () => {
        const terminal = makeTerminal('bash');
        const { execution, input } = makeExecution(['\x1b[31mFAIL src/a.ts\x1b[0m\n', 'more\n']);
        h.startCbs.forEach((cb) => cb({ terminal, execution }));
        input.push('plain\n');
        input.end();
        endRun(terminal, execution);
        await flush();

        const entry = capture.getLatest(terminal);
        expect(entry).not.toBeNull();
        const e = entry as TerminalOutputEntry;
        expect(e.command).toBe('npm test');
        expect(e.output).toBe('FAIL src/a.ts\nmore\nplain\n');
        expect(e.terminalName).toBe('bash');
    });

    it('does not expose output before the command ends', async () => {
        const terminal = makeTerminal('bash');
        const { execution, input } = makeExecution(['partial ']);
        h.startCbs.forEach((cb) => cb({ terminal, execution }));
        input.push('still running');
        await flush();

        expect(capture.getLatest(terminal)).toBeNull();
    });

    it('prefers the requested terminal and falls back to the most recent one', async () => {
        const termA = makeTerminal('a');
        const termB = makeTerminal('b');
        const runA = makeExecution(['out-a\n']);
        const runB = makeExecution(['out-b\n']);
        h.startCbs.forEach((cb) => cb({ terminal: termA, execution: runA.execution }));
        h.startCbs.forEach((cb) => cb({ terminal: termB, execution: runB.execution }));
        runA.input.end();
        runB.input.end();
        endRun(termA, runA.execution);
        endRun(termB, runB.execution);
        await flush();

        const a = capture.getLatest(termA) as TerminalOutputEntry;
        expect(a.output).toBe('out-a\n');
        const latest = capture.getLatest() as TerminalOutputEntry;
        // termB finished last, so the global fallback is its entry
        expect(latest.output).toBe('out-b\n');
        // A terminal with no captured run yields nothing (strict lookup)
        expect(capture.getLatest(makeTerminal('c'))).toBeNull();
    });

    it('discards a run whose terminal starts a new command before it ends', async () => {
        const terminal = makeTerminal('bash');
        const first = makeExecution(['first ']);
        h.startCbs.forEach((cb) => cb({ terminal, execution: first.execution }));
        first.input.push('interrupted');

        const second = makeExecution(['second\n']);
        h.startCbs.forEach((cb) => cb({ terminal, execution: second.execution }));
        second.input.end();
        endRun(terminal, second.execution);
        await flush();

        const entry = capture.getLatest(terminal) as TerminalOutputEntry;
        expect(entry.output).toBe('second\n');
    });

    it('bounds runaway output by the capture cap', async () => {
        const terminal = makeTerminal('bash');
        const big = 'x'.repeat(70000);
        const { execution, input } = makeExecution([big]);
        h.startCbs.forEach((cb) => cb({ terminal, execution }));
        input.end();
        endRun(terminal, execution);
        await flush();

        const entry = capture.getLatest(terminal) as TerminalOutputEntry;
        expect(entry.output.length).toBeLessThanOrEqual(TERMINAL_OUTPUT_MAX_CHARS + 60);
        expect(entry.output.startsWith('[...')).toBe(true);
        expect(entry.output.endsWith('x')).toBe(true);
    });

    it('forgets a terminal and drops its in-flight run when it closes', async () => {
        const terminal = makeTerminal('bash');
        const { execution, input } = makeExecution(['out\n']);
        h.startCbs.forEach((cb) => cb({ terminal, execution }));
        input.end();
        endRun(terminal, execution);
        await flush();
        expect(capture.getLatest(terminal)).not.toBeNull();

        h.closeCbs.forEach((cb) => cb(terminal));
        expect(capture.getLatest(terminal)).toBeNull();
    });

    it('discards a run whose read stream fails', async () => {
        const terminal = makeTerminal('bash');
        const execution = {
            commandLine: { value: 'npm test', confidence: 2, isTrusted: true },
            async *read() {
                yield 'partial\n';
                throw new Error('stream died');
            },
        };
        h.startCbs.forEach((cb) => cb({ terminal, execution }));
        endRun(terminal, execution);
        await flush();

        expect(capture.getLatest(terminal)).toBeNull();
        expect(capture.getLatest()).toBeNull();
    });

    it('does not publish an in-flight run after disposal', async () => {
        const terminal = makeTerminal('bash');
        const { execution, input } = makeExecution(['late\n']);
        h.startCbs.forEach((cb) => cb({ terminal, execution }));
        endRun(terminal, execution);
        capture.dispose();
        input.end();
        await flush();

        expect(capture.getLatest(terminal)).toBeNull();
        expect(capture.getLatest()).toBeNull();
    });

    it('disposes all subscriptions', () => {
        capture.dispose();
        expect(h.startCbs).toHaveLength(0);
        expect(h.endCbs).toHaveLength(0);
        expect(h.closeCbs).toHaveLength(0);
    });
});
