import * as os from 'node:os';
import * as path from 'node:path';
import type { SkillInfo } from '../shared/protocol';
import { loadPiSdk } from './compat';

/** Normalize a raw SDK skill object into our protocol shape. */
export function mapSkills(rawSkills: any[]): SkillInfo[] {
    return (rawSkills ?? []).map((s: any) => ({
        name: s.name,
        description: s.description ?? '',
        filePath: s.filePath ?? '',
        source: s.sourceInfo?.source ?? '',
        disableModelInvocation: s.disableModelInvocation ?? false,
    }));
}

/**
 * Discover skills on disk without a live agent session (used by the settings
 * page). Goes through the SDK gateway so signature changes surface in one
 * place; degrades to an empty list if `loadSkills` disappears upstream.
 * `agentDir` defaults to the SDK-resolved Pi agent directory so custom agent
 * dirs stay consistent with the live session's skill set.
 */
export async function discoverSkills(cwd: string, agentDir?: string): Promise<SkillInfo[]> {
    const { loadSkills } = await loadPiSdk();
    if (typeof loadSkills !== 'function') {
        return [];
    }
    agentDir ??= await resolveAgentDir();
    const { skills: rawSkills } = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
    return mapSkills(rawSkills);
}

/** SDK-resolved agent dir (conventional `~/.pi/agent` when unavailable). */
export async function resolveAgentDir(): Promise<string> {
    try {
        const sdk = await loadPiSdk();
        if (typeof sdk.getAgentDir === 'function') {
            return String(sdk.getAgentDir());
        }
    } catch {
        /* fall through to the conventional location */
    }
    return path.join(os.homedir(), '.pi', 'agent');
}
