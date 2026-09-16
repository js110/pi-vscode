import { describe, it, expect } from 'vitest';
import {
    applyTaskEvent,
    isTaskTool,
    taskLabel,
    TASK_TOOLS,
    TASK_LABEL_MAX_CHARS,
    TASK_HISTORY_MAX,
    type TaskInfo,
} from '../../../shared/tasks';

describe('isTaskTool', () => {
    it('treats shell tools as long-running tasks', () => {
        for (const name of TASK_TOOLS) {
            expect(isTaskTool(name)).toBe(true);
        }
        expect(isTaskTool('bash')).toBe(true);
        expect(isTaskTool('powershell')).toBe(true);
    });

    it('excludes instant tools from the task panel', () => {
        expect(isTaskTool('read')).toBe(false);
        expect(isTaskTool('grep')).toBe(false);
        expect(isTaskTool('find')).toBe(false);
        expect(isTaskTool('write')).toBe(false);
        expect(isTaskTool('edit')).toBe(false);
    });

    it('is case-insensitive', () => {
        expect(isTaskTool('Bash')).toBe(true);
    });
});

describe('taskLabel', () => {
    it('uses the shell command for shell tools', () => {
        expect(taskLabel('bash', { command: 'npm test' })).toBe('npm test');
    });

    it('truncates long commands with an ellipsis', () => {
        const cmd = 'x'.repeat(200);
        const label = taskLabel('bash', { command: cmd });
        expect(label.length).toBeLessThanOrEqual(TASK_LABEL_MAX_CHARS + 1);
        expect(label.endsWith('…')).toBe(true);
    });

    it('falls back to a tool-only label for opaque args', () => {
        expect(taskLabel('read', {})).toContain('read');
    });
});

describe('applyTaskEvent', () => {
    const T0 = 1_000;

    it('tracks a bash tool call as a running task', () => {
        const tasks = applyTaskEvent([], {
            type: 'tool_execution_start',
            toolCallId: 'c1',
            toolName: 'bash',
            args: { command: 'npm test' },
            now: T0,
        });
        expect(tasks).toEqual([{
            id: 'c1',
            toolName: 'bash',
            label: 'npm test',
            status: 'running',
            startedAt: T0,
        }]);
    });

    it('ignores tool calls that are not long-running tasks', () => {
        const tasks = applyTaskEvent([], {
            type: 'tool_execution_start',
            toolCallId: 'c2',
            toolName: 'read',
            args: { path: '/x' },
            now: T0,
        });
        expect(tasks).toEqual([]);
    });

    it('marks a task done on a successful end event', () => {
        let tasks = applyTaskEvent([], {
            type: 'tool_execution_start',
            toolCallId: 'c1',
            toolName: 'bash',
            args: { command: 'ls' },
            now: T0,
        });
        tasks = applyTaskEvent(tasks, {
            type: 'tool_execution_end',
            toolCallId: 'c1',
            toolName: 'bash',
            isError: false,
            now: T0 + 500,
        });
        expect(tasks).toHaveLength(1);
        expect(tasks[0].status).toBe('done');
        expect(tasks[0].endedAt).toBe(T0 + 500);
    });

    it('marks a task failed when isError is set', () => {
        let tasks = applyTaskEvent([], {
            type: 'tool_execution_start',
            toolCallId: 'c1',
            toolName: 'bash',
            args: { command: 'exit 1' },
            now: T0,
        });
        tasks = applyTaskEvent(tasks, {
            type: 'tool_execution_end',
            toolCallId: 'c1',
            toolName: 'bash',
            isError: true,
            now: T0 + 100,
        });
        expect(tasks[0].status).toBe('failed');
    });

    it('does not mutate the previous task list', () => {
        const before: readonly TaskInfo[] = [{
            id: 'c1',
            toolName: 'bash',
            label: 'ls',
            status: 'running',
            startedAt: T0,
        }];
        const after = applyTaskEvent(before, {
            type: 'tool_execution_end',
            toolCallId: 'c1',
            toolName: 'bash',
            isError: false,
            now: T0 + 10,
        });
        expect(before[0].status).toBe('running');
        expect(after[0].status).toBe('done');
    });

    it('ignores an end event for a tool never tracked', () => {
        const tasks = applyTaskEvent([], {
            type: 'tool_execution_end',
            toolCallId: 'ghost',
            toolName: 'read',
            isError: false,
            now: T0,
        });
        expect(tasks).toEqual([]);
    });

    it('returns the original reference when nothing changed (no state push)', () => {
        const before: TaskInfo[] = [{
            id: 'c1',
            toolName: 'bash',
            label: 'ls',
            status: 'running',
            startedAt: T0,
        }];
        expect(applyTaskEvent(before, {
            type: 'tool_execution_start',
            toolCallId: 'c1',
            toolName: 'bash',
            args: { command: 'ls' },
            now: T0,
        })).toBe(before);
        expect(applyTaskEvent(before, {
            type: 'tool_execution_end',
            toolCallId: 'ghost',
            toolName: 'bash',
            isError: false,
            now: T0 + 1,
        })).toBe(before);
        expect(applyTaskEvent(before, {
            type: 'tool_execution_start',
            toolCallId: 'r1',
            toolName: 'read',
            args: { path: '/x' },
            now: T0 + 2,
        })).toBe(before);
    });

    it('does not duplicate a task when start fires twice', () => {
        const start = {
            type: 'tool_execution_start' as const,
            toolCallId: 'c1',
            toolName: 'bash',
            args: { command: 'ls' },
        };
        let tasks = applyTaskEvent([], { ...start, now: T0 });
        tasks = applyTaskEvent(tasks, { ...start, now: T0 + 5 });
        expect(tasks).toHaveLength(1);
        expect(tasks[0].startedAt).toBe(T0);
    });

    it('keeps finished tasks so the panel shows history within the turn', () => {
        let tasks = applyTaskEvent([], {
            type: 'tool_execution_start',
            toolCallId: 'c1',
            toolName: 'bash',
            args: { command: 'ls' },
            now: T0,
        });
        tasks = applyTaskEvent(tasks, {
            type: 'tool_execution_end',
            toolCallId: 'c1',
            toolName: 'bash',
            isError: false,
            now: T0 + 10,
        });
        tasks = applyTaskEvent(tasks, {
            type: 'tool_execution_start',
            toolCallId: 'c2',
            toolName: 'bash',
            args: { command: 'npm test' },
            now: T0 + 20,
        });
        expect(tasks.map((t) => t.status)).toEqual(['done', 'running']);
    });

    it('trims finished history beyond the cap, always keeping running tasks', () => {
        let tasks: TaskInfo[] = [];
        // TASK_HISTORY_MAX + 5 finished tasks, then one running at the end.
        for (let i = 0; i < TASK_HISTORY_MAX + 5; i++) {
            tasks = applyTaskEvent(tasks, {
                type: 'tool_execution_start',
                toolCallId: `c${i}`,
                toolName: 'bash',
                args: { command: `cmd ${i}` },
                now: T0 + i,
            });
            tasks = applyTaskEvent(tasks, {
                type: 'tool_execution_end',
                toolCallId: `c${i}`,
                toolName: 'bash',
                isError: false,
                now: T0 + i + 1,
            });
        }
        tasks = applyTaskEvent(tasks, {
            type: 'tool_execution_start',
            toolCallId: 'live',
            toolName: 'bash',
            args: { command: 'tail -f x.log' },
            now: T0 + 100,
        });

        expect(tasks).toHaveLength(TASK_HISTORY_MAX + 1);
        // Oldest finished entries were dropped, newest kept, running kept.
        expect(tasks.some((t) => t.id === 'c0')).toBe(false);
        expect(tasks.some((t) => t.id === `c${TASK_HISTORY_MAX + 4}`)).toBe(true);
        expect(tasks[tasks.length - 1]).toMatchObject({ id: 'live', status: 'running' });
    });
});
