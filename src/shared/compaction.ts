/**
 * Pure decision state machine for the compaction prompt flow (PRD C5):
 * prompt once when usage crosses the warning threshold, re-prompt once at
 * 90%, and stay quiet otherwise. Reset to 'none' after compaction or a
 * session switch.
 */
export type CompactionStage = 'none' | 'threshold' | 'final';

/**
 * Returns the prompt stage to fire now, or null to stay quiet.
 * - percent < threshold → quiet
 * - threshold ≤ percent < 90 → 'threshold' only from stage 'none'
 * - percent ≥ 90 → 'final' unless already fired at 'final'
 */
export function decideCompactionPrompt(
    percent: number,
    threshold: number,
    stage: CompactionStage,
): CompactionStage | null {
    if (percent < threshold) return null;
    if (percent >= 90) return stage === 'final' ? null : 'final';
    return stage === 'none' ? 'threshold' : null;
}
