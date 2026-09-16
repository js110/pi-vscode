import { fenceFor } from './mention';

export interface TerminalOutputEntry {
    command: string;
    output: string;
    terminalName: string;
}

export type TerminalQuoteFailureReason =
    | 'noTerminal'
    | 'noShellIntegration'
    | 'noOutput';

export type TerminalQuoteResult =
    | { ok: true; entry: TerminalOutputEntry }
    | { ok: false; reason: TerminalQuoteFailureReason };

/** Output ceiling for quotes; recent lines (where errors live) are kept. */
export const TERMINAL_OUTPUT_MAX_CHARS = 8000;

/**
 * Remove terminal escape sequences and emulate carriage-return overwrites
 * so the result matches what the user actually saw on screen.
 */
export function stripAnsi(text: string): string {
    let out = text
        // OSC (title, hyperlinks): terminated by BEL or ST
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        // CSI (SGR colors, cursor moves, private modes)
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        // Remaining two-byte ESC sequences
        .replace(/\x1b[@-Z\\-_]/g, '')
        // Standalone control chars except newline
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

    out = out.replace(/\r\n/g, '\n');
    // A \r returns the cursor to column 0; following characters overwrite
    // from there, but anything past their length survives — exactly like
    // a real terminal rendering progress bars.
    out = out
        .split('\n')
        .map((line) => {
            const parts = line.split('\r');
            if (parts.length === 1) return line;
            let rendered = parts[0];
            for (let i = 1; i < parts.length; i++) {
                const overlay = parts[i];
                rendered = overlay + rendered.slice(Math.min(overlay.length, rendered.length));
            }
            return rendered;
        })
        .join('\n');
    return out;
}

/** Cap oversized output keeping its tail; errors usually appear last. */
export function truncateTerminalOutput(output: string, max: number = TERMINAL_OUTPUT_MAX_CHARS): string {
    if (output.length <= max) return output;
    const omitted = output.length - max;
    const marker = `[... ${omitted} characters truncated ...]`;
    return `${marker}\n${output.slice(output.length - max)}`;
}

/** Wrap a captured command + output as a fenced prompt block. */
export function formatTerminalQuote(entry: TerminalOutputEntry): string {
    const body = [
        `$ ${entry.command}`.trimEnd(),
        entry.output.length > 0 ? entry.output : '(no output)',
    ].join('\n');
    const fence = fenceFor(body);
    return `${fence}text [terminal: ${entry.terminalName}]\n${body}\n${fence}`;
}
