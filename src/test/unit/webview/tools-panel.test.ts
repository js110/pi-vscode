// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildToolsPanel, groupByNamespace } from '../../../webview/render/tools-panel';
import type { ToolDetailInfo } from '../../../shared/protocol';

const BUILTIN_READ: ToolDetailInfo = { name: 'read', label: 'Read', description: 'Read a file', exposure: 'direct' };
const BUILTIN_WRITE: ToolDetailInfo = { name: 'write', description: 'Write a file', exposure: 'direct' };
const MCP_DOCS_A: ToolDetailInfo = {
    name: 'mcp__docs__search', description: 'Search docs', exposure: 'direct',
    namespace: 'mcp__docs', namespaceDescription: 'Documentation server',
};
const MCP_DOCS_B: ToolDetailInfo = { name: 'mcp__docs__fetch', description: 'Fetch docs', exposure: 'direct', namespace: 'mcp__docs' };
const MCP_OTHER: ToolDetailInfo = { name: 'mcp__radius__run', description: 'Run', exposure: 'direct', namespace: 'mcp__radius' };
const CODEMODE: ToolDetailInfo = { name: 'codemode', description: 'Programmatic tool calls', exposure: 'codemode' };

describe('groupByNamespace', () => {
    it('leads with the unnamed group and keeps first-seen MCP server order', () => {
        const groups = groupByNamespace([MCP_DOCS_A, BUILTIN_READ, MCP_OTHER, MCP_DOCS_B, BUILTIN_WRITE]);
        expect(groups.map((g) => g.namespace ?? '<builtin>')).toEqual(['<builtin>', 'mcp__docs', 'mcp__radius']);
        expect(groups[0].tools.map((tool) => tool.name)).toEqual(['read', 'write']);
        expect(groups[1].tools.map((tool) => tool.name)).toEqual(['mcp__docs__search', 'mcp__docs__fetch']);
    });

    it('returns a single unnamed group when no namespaces exist', () => {
        const groups = groupByNamespace([BUILTIN_READ, BUILTIN_WRITE]);
        expect(groups).toHaveLength(1);
        expect(groups[0].namespace).toBeUndefined();
    });
});

describe('buildToolsPanel', () => {
    it('groups MCP tools under server headers and shows active state', () => {
        const panel = buildToolsPanel([BUILTIN_READ, MCP_DOCS_A, MCP_DOCS_B], new Set(['read', 'mcp__docs__search']), '');
        const headers = [...panel.querySelectorAll('.tools-group-name')].map((node) => node.textContent);
        expect(headers).toEqual(['Built-in', 'mcp__docs']);
        const rows = [...panel.querySelectorAll('.tools-item')];
        expect(rows).toHaveLength(3);
        expect(rows[0].querySelector<HTMLInputElement>('.tools-item-toggle')!.checked).toBe(true);
        expect(rows[1].querySelector<HTMLInputElement>('.tools-item-toggle')!.checked).toBe(true);
        expect(rows[2].querySelector<HTMLInputElement>('.tools-item-toggle')!.checked).toBe(false);
    });

    it('labels the built-in group when MCP sections are present', () => {
        const panel = buildToolsPanel([BUILTIN_READ, MCP_DOCS_A], new Set([]), '');
        const headers = [...panel.querySelectorAll('.tools-group-name')].map((node) => node.textContent);
        expect(headers).toContain('Built-in');
        expect(headers).toContain('mcp__docs');
    });

    it('shows the group description once per server', () => {
        const panel = buildToolsPanel([MCP_DOCS_A, MCP_DOCS_B], new Set([]), '');
        expect(panel.querySelectorAll('.tools-group-desc')).toHaveLength(1);
        expect(panel.querySelector('.tools-group-desc')!.textContent).toBe('Documentation server');
    });

    it('badges non-direct exposure and keeps rows out of the label flow', () => {
        const panel = buildToolsPanel([CODEMODE], new Set([]), '');
        expect(panel.querySelector('.tools-item-exposure')!.textContent).toBe('codemode');
    });

    it('filters by name, label and description', () => {
        const all = [BUILTIN_READ, BUILTIN_WRITE, MCP_DOCS_A];
        // 'file' hits both descriptions but no name; 'docs' hits only the MCP name.
        expect(buildToolsPanel(all, new Set([]), 'file').querySelectorAll('.tools-item')).toHaveLength(2);
        expect(buildToolsPanel(all, new Set([]), 'docs').querySelectorAll('.tools-item')).toHaveLength(1);
        expect(buildToolsPanel(all, new Set([]), 'zzz').querySelector('.native-empty')!.textContent).toBeTruthy();
    });

    it('shows an empty state when no tools are configured', () => {
        const panel = buildToolsPanel([], new Set([]), '');
        expect(panel.querySelector('.native-empty')!.textContent).toBeTruthy();
        expect(panel.querySelectorAll('.tools-item')).toHaveLength(0);
    });

    it('escapes tool names and descriptions into attributes and text', () => {
        const hostile: ToolDetailInfo = { name: '"><img src=x>', description: '<script>boom()</script>' };
        const panel = buildToolsPanel([hostile], new Set([]), '');
        expect(panel.querySelector('script')).toBeNull();
        expect(panel.querySelector('img')).toBeNull();
        const row = panel.querySelector('.tools-item')!;
        expect(row.querySelector<HTMLInputElement>('.tools-item-toggle')!.dataset.toolName).toBe('"><img src=x>');
    });
});
