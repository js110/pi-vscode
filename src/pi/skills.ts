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
 */
export async function discoverSkills(cwd: string): Promise<SkillInfo[]> {
    const { loadSkills } = await loadPiSdk();
    if (typeof loadSkills !== 'function') {
        return [];
    }
    const agentDir = path.join(os.homedir(), '.pi', 'agent');
    const { skills: rawSkills } = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
    return mapSkills(rawSkills);
}
