/**
 * Background task panel projection (PRD C11, T15).
 *
 * Task state is projected purely from SDK tool_execution_* events — the
 * extension never models task lifecycles of its own. The SDK (0.84.x) has no
 * subagent tools yet, so the panel degrades to a status list of long-running
 * shell tools; new subagent tool names are added to TASK_TOOLS when the SDK
 * grows them (feature-detect table).
 */

export type TaskStatus = 'running' | 'done' | 'failed';

export interface TaskInfo {
    /** SDK toolCallId. */
    id: string;
    toolName: string;
    label: string;
    status: TaskStatus;
    startedAt: number;
    endedAt?: number;
}

/** Tools whose execution is surfaced as a background task. */
export const TASK_TOOLS: readonly string[] = ['bash', 'powershell'];

export const TASK_LABEL_MAX_CHARS = 80;

export function isTaskTool(toolName: string): boolean {
    return TASK_TOOLS.includes(toolName.toLowerCase());
}

export function taskLabel(toolName: string, args: any): string {
    const command = typeof args?.command === 'string' ? args.command.trim() : '';
    if (command !== '') {
        return command.length > TASK_LABEL_MAX_CHARS
            ? command.slice(0, TASK_LABEL_MAX_CHARS) + '…'
            : command;
    }
    return toolName;
}

export type TaskInputEvent =
    | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args?: any; now: number }
    | { type: 'tool_execution_end'; toolCallId: string; toolName: string; isError?: boolean; now: number };

/** Finished tasks kept in the panel history; running tasks are always kept. */
export const TASK_HISTORY_MAX = 20;

function trimFinished(tasks: TaskInfo[]): TaskInfo[] {
    const finished = tasks.filter((t) => t.status !== 'running');
    if (finished.length <= TASK_HISTORY_MAX) { return tasks; }
    const keepIds = new Set(finished.slice(finished.length - TASK_HISTORY_MAX).map((t) => t.id));
    return tasks.filter((t) => t.status === 'running' || keepIds.has(t.id));
}

/**
 * Immutable fold: returns a new list on change, the ORIGINAL reference when
 * nothing changed (so callers can skip state pushes with a !== check).
 */
export function applyTaskEvent(tasks: readonly TaskInfo[], event: TaskInputEvent): TaskInfo[] {
    if (!isTaskTool(event.toolName)) {
        return tasks as TaskInfo[];
    }
    if (event.type === 'tool_execution_start') {
        if (tasks.some((t) => t.id === event.toolCallId)) {
            return tasks as TaskInfo[];
        }
        return trimFinished([
            ...tasks,
            {
                id: event.toolCallId,
                toolName: event.toolName,
                label: taskLabel(event.toolName, event.args),
                status: 'running',
                startedAt: event.now,
            },
        ]);
    }
    const idx = tasks.findIndex((t) => t.id === event.toolCallId);
    if (idx < 0) {
        return tasks as TaskInfo[];
    }
    return tasks.map((t, i) => (i === idx
        ? { ...t, status: event.isError ? 'failed' : 'done', endedAt: event.now }
        : t));
}
