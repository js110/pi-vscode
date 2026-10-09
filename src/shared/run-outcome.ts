export type RunOutcome = 'completed' | 'cancelled' | 'failed';

/** A failed tool is recoverable; only the final assistant error fails a run. */
export function getRunOutcome(aborted: boolean, messages: readonly any[]): RunOutcome {
    if (aborted) return 'cancelled';
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role !== 'assistant') continue;
        const message = messages[i];
        if (message.stopReason === 'aborted') return 'cancelled';
        if (message.stopReason === 'error' || message.errorMessage) return 'failed';
        break;
    }
    return 'completed';
}
