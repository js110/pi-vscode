import { t, type TextKey } from '../../shared/i18n';
import { escHtml } from '../dom';
import { escAttr } from '../../shared/webview-text';
import type { TaskInfo } from '../../shared/protocol';
import type { SessionOccupancy } from '../../shared/protocol';

/** Human-readable elapsed time for a task entry (m/s, no live timer). */
export function formatTaskElapsed(startedAt: number, endedAt: number | undefined, now: number): string {
    const end = endedAt ?? now;
    const secs = Math.max(0, Math.round((end - startedAt) / 1000));
    if (secs < 60) { return `${secs}s`; }
    return `${Math.floor(secs / 60)}m${secs % 60}s`;
}

const TASK_STATUS_KEY = {
    running: 'tasks.running',
    done: 'tasks.done',
    failed: 'tasks.failed',
} as const;

/** Panel body html (list or empty state) — the header/close button lives in main.ts. */
export function buildTasksListHtml(tasks: readonly TaskInfo[], now: number): string {
    if (tasks.length === 0) {
        return `<div class="tasks-empty">${escHtml(t('tasks.empty'))}</div>`;
    }
    return `
        <div class="tasks-list">
            ${tasks.map((task) => `
                <div class="task-item task-${task.status}" data-task-id="${escAttr(task.id)}">
                    <span class="task-status-dot"></span>
                    <span class="task-label" title="${escAttr(task.label)}">${escHtml(task.label)}</span>
                    <span class="task-status">${escHtml(t(TASK_STATUS_KEY[task.status]))}</span>
                    <span class="task-elapsed">${escHtml(formatTaskElapsed(task.startedAt, task.endedAt, now))}</span>
                    ${task.status === 'running'
                        ? `<button class="task-cancel" title="${escHtml(t('tasks.cancel'))}">&times;</button>`
                        : ''}
                </div>
            `).join('')}
        </div>
    `;
}

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
