import { describe, expect, it } from 'vitest';
import { getRunOutcome } from '../../../shared/run-outcome';

describe('run outcome', () => {
    it('gives native abort priority over existing successful history', () => {
        expect(getRunOutcome(true, [{ role: 'assistant', stopReason: 'stop' }])).toBe('cancelled');
    });
    it('recognizes final assistant failures', () => {
        expect(getRunOutcome(false, [{ role: 'assistant', stopReason: 'error', errorMessage: '500' }])).toBe('failed');
    });
    it('does not label recovered tool or model errors as a failed run', () => {
        expect(getRunOutcome(false, [{ role: 'assistant', stopReason: 'error' }, { role: 'toolResult', isError: true }, { role: 'assistant', stopReason: 'stop' }])).toBe('completed');
    });
});
