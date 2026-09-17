/**
 * Read-only discovery of the user's Pi configuration (~/.pi/agent).
 *
 * Composes the SDK-facing modules (models registry, skills loader) into one
 * snapshot with a status the webview can render: not-found / ok / partial /
 * error. A failing source never clears the last known good list (PRD 6.3) —
 * it is reported as a per-source issue instead. This module never writes to
 * ~/.pi/agent; refresh is pull-based (selector opened / manual re-check).
 */

import * as fs from 'node:fs';
import type { ConfigIssue, ConfigStatus, ModelInfo, PiConfigSnapshot, SkillInfo } from '../shared/protocol';
import { disposeModelRegistry, getAvailableModels, getModelRegistry } from './models';
import { disposeModelRuntime } from './auth';
import { discoverSkills, resolveAgentDir } from './skills';

export interface DiscoveryInputs {
    agentDir: string;
    agentDirExists: boolean;
    /** null = the source failed and its result is unavailable. */
    models: ModelInfo[] | null;
    skills: SkillInfo[] | null;
    errors: ConfigIssue[];
}

export function deriveConfigStatus(inputs: DiscoveryInputs): ConfigStatus {
    if (!inputs.agentDirExists) { return 'not-found'; }
    if (inputs.models === null && inputs.skills === null) { return 'error'; }
    if (inputs.models === null || inputs.skills === null || inputs.errors.length > 0) {
        return 'partial';
    }
    return 'ok';
}

export function buildConfigSnapshot(
    previous: PiConfigSnapshot | undefined,
    inputs: DiscoveryInputs,
    now: number,
): PiConfigSnapshot {
    const models = inputs.models ?? previous?.models ?? [];
    const skills = inputs.skills ?? previous?.skills ?? [];
    const providers = [...new Set(models.map((m) => m.provider))].sort();
    return {
        status: deriveConfigStatus(inputs),
        agentDir: inputs.agentDir,
        agentDirExists: inputs.agentDirExists,
        providers,
        models: [...models],
        skills: skills.map((s) => ({ ...s })),
        errors: inputs.errors.map((e) => ({ ...e })),
        discoveredAt: now,
    };
}

export interface ConfigDiscoveryDeps {
    agentDir(): Promise<string>;
    dirExists(dir: string): boolean;
    models(): Promise<ModelInfo[]>;
    skills(cwd: string): Promise<SkillInfo[]>;
    now(): number;
}

export function defaultConfigDeps(): ConfigDiscoveryDeps {
    return {
        agentDir: resolveAgentDir,
        dirExists: (dir) => {
            try {
                return fs.existsSync(dir);
            } catch {
                return false;
            }
        },
        models: async () => {
            const registry = await getModelRegistry();
            return getAvailableModels(registry);
        },
        skills: (cwd) => discoverSkills(cwd),
        now: () => Date.now(),
    };
}

export async function discoverPiConfig(
    cwd: string,
    deps: ConfigDiscoveryDeps = defaultConfigDeps(),
    previous?: PiConfigSnapshot,
): Promise<PiConfigSnapshot> {
    const agentDir = await deps.agentDir();
    const agentDirExists = deps.dirExists(agentDir);

    if (!agentDirExists) {
        return buildConfigSnapshot(previous, {
            agentDir,
            agentDirExists: false,
            models: null,
            skills: null,
            errors: [{ source: 'agentDir', message: `Pi agent directory not found: ${agentDir}` }],
        }, deps.now());
    }

    const errors: ConfigIssue[] = [];
    const [models, skills] = await Promise.all([
        deps.models().catch((err: any) => {
            errors.push({ source: 'models', message: err?.message ?? String(err) });
            return null;
        }),
        deps.skills(cwd).catch((err: any) => {
            errors.push({ source: 'skills', message: err?.message ?? String(err) });
            return null;
        }),
    ]);

    return buildConfigSnapshot(previous, { agentDir, agentDirExists: true, models, skills, errors }, deps.now());
}

let lastSnapshot: PiConfigSnapshot | undefined;

export function getLastConfigSnapshot(): PiConfigSnapshot | undefined {
    return lastSnapshot;
}

/** Discover once per session; later callers get the cached snapshot. */
export async function ensureConfigDiscovered(cwd: string): Promise<PiConfigSnapshot> {
    if (!lastSnapshot) {
        lastSnapshot = await discoverPiConfig(cwd);
    }
    return lastSnapshot;
}

/**
 * Pull-based hot refresh: drop the cached runtime/registry, re-run discovery.
 * Keeps the previous snapshot as fallback so a failing refresh preserves the
 * last known good lists.
 */
export async function refreshPiConfig(cwd: string): Promise<PiConfigSnapshot> {
    disposeModelRegistry();
    disposeModelRuntime();
    lastSnapshot = await discoverPiConfig(cwd, defaultConfigDeps(), lastSnapshot);
    return lastSnapshot;
}
