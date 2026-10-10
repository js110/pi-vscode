import type { RunOutcome } from './run-outcome';

/**
 * Pi 1.1.0's program status states (working / blocked / done / error / idle,
 * normally reported over OSC 7501 — see the SDK's terminal-setup docs).
 * The extension host never touches a terminal, so the state machine is
 * re-derived here from host-side signals and shown in the VS Code status bar.
 */
export type ProgramStatus = 'working' | 'blocked' | 'done' | 'error' | 'idle';

export interface ProgramStatusInput {
    isStreaming: boolean;
    compactionInFlight: boolean;
    /** An extension dialog/custom view is open or an approval card awaits the user. */
    waitingForUser: boolean;
    runOutcome?: RunOutcome;
}

export function deriveProgramStatus(input: ProgramStatusInput): ProgramStatus {
    // Blocked outranks working: a run paused on a dialog/login/approval is
    // waiting for the user, not for the model.
    if (input.waitingForUser) return 'blocked';
    if (input.isStreaming || input.compactionInFlight) return 'working';
    if (input.runOutcome === 'failed') return 'error';
    if (input.runOutcome === 'completed') return 'done';
    // 'cancelled' and no-run-yet both mean: nothing in flight.
    return 'idle';
}
