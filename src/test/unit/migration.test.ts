import { describe, it, expect } from 'vitest';
import pkg from '../../../package.json';
import { parseGlobalRules } from '../../pi/approval-memory';
import { API_KEY_PREFIX } from '../../shared/protocol';

// AC-OP-04 (PRD 13.5): the upstream extension's settings keys must survive
// upgrades; new keys may be added but none may be renamed away, or an old
// value would silently vanish.
const UPSTREAM_SETTINGS_KEYS = [
    'pi-agent.allowedTools',
    'pi-agent.apiProvider',
    'pi-agent.autoApproveTools',
    'pi-agent.autoSaveSessions',
    'pi-agent.contextUsageWarningThreshold',
    'pi-agent.defaultModel',
    'pi-agent.sessionStoragePath',
    'pi-agent.thinkingLevel',
] as const;

describe('upgrade/rollback data compatibility (AC-OP-04)', () => {
    it('keeps every upstream settings key in package.json', () => {
        const current = Object.keys(
            (pkg as { contributes: { configuration: { properties: Record<string, unknown> } } })
                .contributes.configuration.properties,
        );
        const missing = UPSTREAM_SETTINGS_KEYS.filter((k) => !current.includes(k));
        expect(missing).toEqual([]);
    });

    it('keeps the upstream SecretStorage key namespace for API keys', () => {
        // Renaming this prefix would silently orphan keys stored by the
        // previous version (the one rollback-compatible data write).
        expect(API_KEY_PREFIX).toBe('pi-agent.apiKey.');
    });

    describe('parseGlobalRules initializes empty and never throws on old data', () => {
        it('returns empty for absent / null / non-array state', () => {
            expect(parseGlobalRules(undefined)).toEqual([]);
            expect(parseGlobalRules(null)).toEqual([]);
            expect(parseGlobalRules('nope')).toEqual([]);
            expect(parseGlobalRules({})).toEqual([]);
        });

        it('keeps well-formed rules', () => {
            const raw = [{ tool: 'read', createdAt: 1234 }, { tool: 'grep', createdAt: 5678 }];
            expect(parseGlobalRules(raw)).toEqual(raw);
        });

        it('filters malformed entries instead of failing', () => {
            const raw = [
                null,
                42,
                'read',
                { createdAt: 1 },
                { tool: '', createdAt: 1 },
                { tool: 'bash', createdAt: 'yesterday' },
                { tool: 'read', createdAt: 1 },
            ];
            expect(parseGlobalRules(raw)).toEqual([{ tool: 'read', createdAt: 1 }]);
        });
    });
});
