import * as vscode from 'vscode';
import { stripAnsi, truncateTerminalOutput, type TerminalOutputEntry } from '../shared/terminal-quote';

/** Per-run raw capture ceiling; the formatted quote truncates again. */
const RAW_CAPTURE_MAX_CHARS = 64 * 1024;

interface PendingRun {
    terminal: vscode.Terminal;
    execution: vscode.TerminalShellExecution;
    chunks: string[];
    total: number;
    abandoned: boolean;
    ended: boolean;
    drained: boolean;
}

/**
 * Records the output of shell-integration commands run in the integrated
 * terminal (stable API only): the newest completed run per terminal is kept
 * for the webview's quote-terminal entry point. Scrollback and user
 * selection are proposed API and deliberately not read.
 */
export class TerminalCapture implements vscode.Disposable {
    private readonly _pending = new Map<vscode.TerminalShellExecution, PendingRun>();
    private readonly _latestByTerminal = new Map<vscode.Terminal, TerminalOutputEntry>();
    private _latest: TerminalOutputEntry | null = null;
    private _disposed = false;
    private readonly _subscriptions: vscode.Disposable[] = [
        vscode.window.onDidStartTerminalShellExecution((e) => this._onStart(e)),
        vscode.window.onDidEndTerminalShellExecution((e) => this._onEnd(e)),
        vscode.window.onDidCloseTerminal((t) => this._onClose(t)),
    ];

    /**
     * Newest completed run. With a terminal: strictly that terminal's run
     * (no cross-terminal fallback — quoting a different terminal's output
     * would surprise the user). Without: the most recent run overall.
     */
    getLatest(terminal?: vscode.Terminal): TerminalOutputEntry | null {
        if (terminal) return this._latestByTerminal.get(terminal) ?? null;
        return this._latest;
    }

    dispose(): void {
        this._disposed = true;
        for (const sub of this._subscriptions) sub.dispose();
        this._pending.clear();
        this._latestByTerminal.clear();
        this._latest = null;
    }

    private _onStart(event: vscode.TerminalShellExecutionStartEvent): void {
        // A terminal starting a new command while one is still pending
        // means the previous run was interrupted — it never completes.
        for (const run of this._pending.values()) {
            if (run.terminal === event.terminal) {
                run.abandoned = true;
                this._pending.delete(run.execution);
            }
        }
        const run: PendingRun = {
            terminal: event.terminal,
            execution: event.execution,
            chunks: [],
            total: 0,
            abandoned: false,
            ended: false,
            drained: false,
        };
        this._pending.set(event.execution, run);
        void this._drain(run);
    }

    private _onEnd(event: vscode.TerminalShellExecutionEndEvent): void {
        const run = this._pending.get(event.execution);
        if (!run) return;
        run.ended = true;
        // The end event can fire while the read loop still has buffered
        // data to consume — finalize only once both sides are done.
        this._maybeFinalize(run);
    }

    private _onClose(terminal: vscode.Terminal): void {
        this._latestByTerminal.delete(terminal);
        for (const run of this._pending.values()) {
            if (run.terminal === terminal) {
                run.abandoned = true;
                this._pending.delete(run.execution);
            }
        }
    }

    private _maybeFinalize(run: PendingRun): void {
        if (!run.ended || !run.drained) return;
        this._pending.delete(run.execution);
        if (this._disposed || run.abandoned) return;
        const output = truncateTerminalOutput(stripAnsi(run.chunks.join('')));
        const entry: TerminalOutputEntry = {
            command: run.execution.commandLine?.value ?? '',
            output,
            terminalName: run.terminal.name,
        };
        this._latestByTerminal.set(run.terminal, entry);
        this._latest = entry;
    }

    private async _drain(run: PendingRun): Promise<void> {
        try {
            for await (const data of run.execution.read()) {
                run.chunks.push(data);
                run.total += data.length;
                if (run.total > RAW_CAPTURE_MAX_CHARS) break;
            }
        } catch {
            // Stream died (terminal closed / command interrupted).
            run.abandoned = true;
        } finally {
            run.drained = true;
            this._maybeFinalize(run);
        }
    }
}
