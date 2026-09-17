import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    BUILTIN_COMMANDS,
    parseBuiltinSlashCommand,
    extractLastAssistantText,
    rankSlashMenuItems,
} from '../../../shared/slash-commands';

describe('rankSlashMenuItems', () => {
    const items = [
        {
            name: 'handoff',
            label: '/skill:handoff',
            description: 'Compact the current conversation into a handoff document for another agent.',
        },
        { name: 'compact', label: '/compact', description: 'Manually compact the session context' },
        { name: 'clear', label: '/clear', description: 'Clear the conversation' },
    ];

    it('ranks a name prefix match above a description match', () => {
        expect(rankSlashMenuItems(items, 'compa').map((item) => item.name)).toEqual(['compact', 'handoff']);
    });

    it('keeps registration order for an empty query', () => {
        expect(rankSlashMenuItems(items, '').map((item) => item.name)).toEqual([
            'handoff',
            'compact',
            'clear',
        ]);
    });

    it('matches a /skill: prefixed query via the label', () => {
        expect(rankSlashMenuItems(items, 'skill:hand').map((item) => item.name)).toEqual(['handoff']);
    });

    it('drops items with no match', () => {
        expect(rankSlashMenuItems(items, 'nomatch')).toEqual([]);
    });

    it('prefers a name substring over a description match', () => {
        const list = [
            { name: 'plan-x', description: 'learn things' },
            { name: 'clear', description: '' },
        ];
        expect(rankSlashMenuItems(list, 'lear').map((item) => item.name)).toEqual(['clear', 'plan-x']);
    });

    it('is case-insensitive', () => {
        expect(rankSlashMenuItems(items, 'COMPACT').map((item) => item.name)).toEqual(['compact', 'handoff']);
    });
});

describe('parseBuiltinSlashCommand', () => {
    it('matches a bare command name', () => {
        expect(parseBuiltinSlashCommand('/compact')).toEqual({ name: 'compact', args: '' });
    });

    it('trims surrounding whitespace and keeps the remainder as args', () => {
        expect(parseBuiltinSlashCommand('  /name   My Session  ')).toEqual({
            name: 'name',
            args: 'My Session',
        });
    });

    it('keeps multi-line arguments verbatim (trimmed)', () => {
        expect(parseBuiltinSlashCommand('/compact keep the plan\nand todos')).toEqual({
            name: 'compact',
            args: 'keep the plan\nand todos',
        });
    });

    it('is case-insensitive on the command name', () => {
        expect(parseBuiltinSlashCommand('/Compact')).toEqual({ name: 'compact', args: '' });
    });

    it('returns null for non-commands and unknown commands', () => {
        expect(parseBuiltinSlashCommand('hello world')).toBeNull();
        expect(parseBuiltinSlashCommand('/')).toBeNull();
        expect(parseBuiltinSlashCommand('/unknowncmd')).toBeNull();
        expect(parseBuiltinSlashCommand('/compactx')).toBeNull();
        expect(parseBuiltinSlashCommand('/123')).toBeNull();
    });

    it('returns null for a command mentioned mid-text', () => {
        expect(parseBuiltinSlashCommand('please run /compact now')).toBeNull();
    });

    it('does not treat skill or template commands as builtins', () => {
        expect(parseBuiltinSlashCommand('/skill:something')).toBeNull();
    });

    it('exposes every mirrored builtin with a description', () => {
        const names = BUILTIN_COMMANDS.map((command) => command.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names).toContain('compact');
        expect(names).toContain('new');
        for (const command of BUILTIN_COMMANDS) {
            expect(command.description.length).toBeGreaterThan(0);
        }
    });
});

describe('extractLastAssistantText', () => {
    it('returns the text of the last assistant message', () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
            { role: 'user', content: [{ type: 'text', text: 'more' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
        ];
        expect(extractLastAssistantText(messages)).toBe('second');
    });

    it('skips assistant messages without text and keeps searching backwards', () => {
        const messages = [
            { role: 'assistant', content: [{ type: 'text', text: 'real reply' }] },
            { role: 'assistant', content: [{ type: 'tool_call', id: 't1' }] },
        ];
        expect(extractLastAssistantText(messages)).toBe('real reply');
    });

    it('joins multiple text parts with newlines', () => {
        const messages = [
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
            },
        ];
        expect(extractLastAssistantText(messages)).toBe('a\nb');
    });

    it('accepts string content', () => {
        expect(extractLastAssistantText([{ role: 'assistant', content: 'plain' }])).toBe('plain');
    });

    it('returns null when there is no assistant text', () => {
        expect(extractLastAssistantText([])).toBeNull();
        expect(extractLastAssistantText([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])).toBeNull();
        expect(
            extractLastAssistantText([{ role: 'assistant', content: [{ type: 'tool_call', id: 't1' }] }]),
        ).toBeNull();
    });
});

describe('SDK builtin command mirror guard', () => {
    const sdkSlashCommandsPath = path.join(
        process.cwd(),
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'core',
        'slash-commands.js',
    );
    const itIfSdk = it.skipIf(!fs.existsSync(sdkSlashCommandsPath));

    // The mirror is hand-copied because the SDK doesn't export the list.
    // If an SDK upgrade changes the builtin set, this forces the mirror to
    // be synced before the tests pass again.
    itIfSdk('mirrors the installed SDK builtin command list', () => {
        const source = fs.readFileSync(sdkSlashCommandsPath, 'utf-8');
        const sdkNames = [...source.matchAll(/name: "([a-z-]+)"/g)].map((m) => m[1]);
        expect(sdkNames.length).toBeGreaterThan(0);
        const mirrorNames = BUILTIN_COMMANDS.map((c) => c.name);
        expect([...mirrorNames].sort()).toEqual([...new Set(sdkNames)].sort());
    });
});
