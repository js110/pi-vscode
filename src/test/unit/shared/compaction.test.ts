import { describe, it, expect } from 'vitest';
import { decideCompactionPrompt, type CompactionStage } from '../../../shared/compaction';

describe('decideCompactionPrompt', () => {
    it('prompts at the threshold when nothing was prompted yet', () => {
        expect(decideCompactionPrompt(80, 80, 'none')).toBe('threshold');
        expect(decideCompactionPrompt(85, 80, 'none')).toBe('threshold');
    });

    it('does not re-prompt within the threshold band', () => {
        expect(decideCompactionPrompt(84, 80, 'threshold')).toBeNull();
        expect(decideCompactionPrompt(89, 80, 'threshold')).toBeNull();
    });

    it('re-prompts at 90% even after a threshold-stage prompt', () => {
        expect(decideCompactionPrompt(90, 80, 'threshold')).toBe('final');
        expect(decideCompactionPrompt(95, 80, 'threshold')).toBe('final');
    });

    it('does not repeat the final prompt', () => {
        expect(decideCompactionPrompt(92, 80, 'final')).toBeNull();
    });

    it('prompts once when usage jumps straight past 90%', () => {
        expect(decideCompactionPrompt(95, 80, 'none')).toBe('final');
    });

    it('is quiet below the threshold', () => {
        expect(decideCompactionPrompt(79, 80, 'none')).toBeNull();
        expect(decideCompactionPrompt(50, 80, 'final')).toBeNull();
    });
});
