import { t, type TextKey } from '../../shared/i18n';
import { escHtml } from '../dom';
import type { SessionOccupancy } from '../../shared/protocol';

const OCCUPANCY_HINT_KEY: Record<Exclude<SessionOccupancy, 'none'>, TextKey> = {
    occupiedByOther: 'occupancy.occupied',
    releasedByOther: 'occupancy.released',
    lostLock: 'occupancy.lostLock',
};

/** Banner html for a non-none occupancy state ('none'/null callers skip rendering). */
export function buildOccupancyBannerHtml(occupancy: Exclude<SessionOccupancy, 'none'>): string {
    const hintKey = OCCUPANCY_HINT_KEY[occupancy];
    const actionLabel = occupancy === 'releasedByOther' ? t('occupancy.resume') : t('occupancy.takeover');
    return `
        <span class="compaction-banner-title">${escHtml(t(hintKey))}</span>
        <span class="compaction-banner-actions">
            <button class="compaction-btn compaction-accept" id="occupancy-takeover">${escHtml(actionLabel)}</button>
        </span>
    `;
}
