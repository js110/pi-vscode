// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
    formatTaskElapsed,
    buildTasksListHtml,
    buildOccupancyBannerHtml,
} from '../../../webview/render/tasks';
import { setLang } from '../../../shared/i18n';
import type { TaskInfo } from '../../../shared/protocol';

describe('formatTaskElapsed', () => {
    it('shows seconds under a minute', () => {
        expect(formatTaskElapsed(0, 45_000, 45_000)).toBe('45s');
    });

    it('shows minutes and seconds over a minute', () => {
        expect(formatTaskElapsed(0, 125_000, 125_000)).toBe('2m5s');
    });

    it('uses now for running tasks', () => {
        expect(formatTaskElapsed(0, undefined, 30_000)).toBe('30s');
    });

    it('never goes negative', () => {
        expect(formatTaskElapsed(10_000, 0, 10_000)).toBe('0s');
    });
});

describe('buildTasksListHtml', () => {
    const NOW = 100_000;

    it('renders the empty state when there are no tasks', () => {
        const html = buildTasksListHtml([], NOW);
        expect(html).toContain('tasks-empty');
        expect(html).not.toContain('task-item');
    });

    it('renders each task with its status and label', () => {
        const tasks: TaskInfo[] = [
            { id: 'c1', toolName: 'bash', label: 'npm test', status: 'running', startedAt: 90_000 },
            { id: 'c2', toolName: 'bash', label: 'ls', status: 'done', startedAt: 80_000, endedAt: 81_000 },
            { id: 'c3', toolName: 'bash', label: 'exit 1', status: 'failed', startedAt: 70_000, endedAt: 71_000 },
        ];
        const html = buildTasksListHtml(tasks, NOW);
        expect(html).toContain('task-item task-running');
        expect(html).toContain('task-item task-done');
        expect(html).toContain('task-item task-failed');
        expect(html).toContain('npm test');
        expect(html).toContain('data-task-id="c1"');
    });

    it('only running tasks get a cancel button', () => {
        const tasks: TaskInfo[] = [
            { id: 'c1', toolName: 'bash', label: 'a', status: 'running', startedAt: 0 },
            { id: 'c2', toolName: 'bash', label: 'b', status: 'done', startedAt: 0, endedAt: 1 },
        ];
        const html = buildTasksListHtml(tasks, NOW);
        expect(html).toContain('task-cancel');
        expect((html.match(/task-cancel/g) ?? []).length).toBe(1);
    });

    it('escapes the command label', () => {
        const tasks: TaskInfo[] = [
            { id: 'c1', toolName: 'bash', label: 'echo "<x>"', status: 'running', startedAt: 0 },
        ];
        expect(buildTasksListHtml(tasks, NOW)).not.toContain('echo "<x>"');
        expect(buildTasksListHtml(tasks, NOW)).toContain('&quot;');
    });
});

describe('buildOccupancyBannerHtml', () => {
    it('prompts takeover while another window holds the session', () => {
        expect(buildOccupancyBannerHtml('occupiedByOther')).toContain('occupancy-takeover');
    });

    it('labels the action as resuming after the occupier releases', () => {
        const html = buildOccupancyBannerHtml('releasedByOther');
        expect(html).toContain('occupancy-takeover');
    });

    it('follows the active language', () => {
        setLang('zh');
        expect(buildOccupancyBannerHtml('lostLock')).toContain('接管');
        setLang('en');
    });
});
