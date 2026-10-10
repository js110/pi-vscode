import { describe, it, expect } from 'vitest';
import { deriveProgramStatus } from '../../../shared/program-status';

const base = {
    isStreaming: false,
    compactionInFlight: false,
    waitingForUser: false,
};

describe('deriveProgramStatus (Pi 1.1.0 program status mapping)', () => {
    it('is idle before any run and after a cancelled run', () => {
        expect(deriveProgramStatus({ ...base })).toBe('idle');
        expect(deriveProgramStatus({ ...base, runOutcome: 'cancelled' })).toBe('idle');
    });

    it('is working while streaming or compacting', () => {
        expect(deriveProgramStatus({ ...base, isStreaming: true })).toBe('working');
        expect(deriveProgramStatus({ ...base, compactionInFlight: true })).toBe('working');
    });

    it('blocked outranks working: a paused dialog/approval waits for the user', () => {
        expect(deriveProgramStatus({ ...base, isStreaming: true, waitingForUser: true })).toBe('blocked');
    });

    it('maps the settled run outcome to done/error', () => {
        expect(deriveProgramStatus({ ...base, runOutcome: 'completed' })).toBe('done');
        expect(deriveProgramStatus({ ...base, runOutcome: 'failed' })).toBe('error');
    });

    it('working outranks the previous run outcome', () => {
        expect(deriveProgramStatus({ ...base, isStreaming: true, runOutcome: 'failed' })).toBe('working');
    });

    it('blocked outranks a settled outcome (approval card after agent_end)', () => {
        expect(deriveProgramStatus({ ...base, waitingForUser: true, runOutcome: 'completed' })).toBe('blocked');
    });
});
