import type { ToolDetailInfo } from '../../shared/protocol';
import { el } from '../dom';
import { t } from '../../shared/i18n';

/**
 * Pure, state-free DOM builder for the tools panel (mirrors
 * buildSessionTreePanel). Groups tools by namespace — tools without one go
 * under "Built-in", each MCP server gets its own section. Rows carry
 * `data-tool-name` and a `.tools-item-toggle` checkbox so the orchestrator
 * (main.ts) can wire postMessage without this module knowing about state.
 */
export function buildToolsPanel(
    tools: readonly ToolDetailInfo[],
    active: ReadonlySet<string>,
    query: string,
): HTMLElement {
    const panel = el('section', 'native-panel tools-panel');
    panel.id = 'tools-panel';
    panel.setAttribute('aria-label', t('tools.title'));
    const header = el('div', 'native-panel-header');
    const title = el('strong'); title.textContent = t('tools.title'); header.appendChild(title);
    const activeCount = el('span', 'tools-active-count');
    activeCount.textContent = t('tools.activeCount', { n: active.size });
    header.appendChild(activeCount);
    const close = el('button', 'icon-btn'); close.dataset.action = 'close'; close.textContent = '×'; close.title = t('native.close'); close.setAttribute('aria-label', t('native.close'));
    header.appendChild(close);
    panel.appendChild(header);

    const search = el('input', 'native-search') as HTMLInputElement;
    search.type = 'search';
    search.value = query;
    search.placeholder = t('tools.search');
    search.setAttribute('aria-label', t('tools.search'));
    panel.appendChild(search);

    const needle = query.toLocaleLowerCase().trim();
    const visible = tools.filter((tool) =>
        !needle
        || `${tool.name} ${tool.label ?? ''} ${tool.description}`.toLocaleLowerCase().includes(needle),
    );

    const list = el('div', 'tools-list');
    if (tools.length === 0) {
        const empty = el('p', 'native-empty'); empty.textContent = t('tools.empty'); list.appendChild(empty);
    } else if (visible.length === 0) {
        const empty = el('p', 'native-empty'); empty.textContent = t('tools.noMatch'); list.appendChild(empty);
    } else {
        const groups = groupByNamespace(visible);
        const hasNamespaced = groups.some((group) => group.namespace);
        for (const group of groups) {
            if (group.namespace) {
                const groupHeader = el('div', 'tools-group-header');
                const groupName = el('strong', 'tools-group-name');
                groupName.textContent = group.namespace;
                groupHeader.appendChild(groupName);
                if (group.description) {
                    const groupDesc = el('span', 'tools-group-desc');
                    groupDesc.textContent = group.description;
                    groupHeader.appendChild(groupDesc);
                }
                list.appendChild(groupHeader);
            } else if (hasNamespaced) {
                // The unnamed group only needs a header when MCP sections exist.
                const builtinHeader = el('div', 'tools-group-header');
                const builtinName = el('strong', 'tools-group-name');
                builtinName.textContent = t('tools.builtinGroup');
                builtinHeader.appendChild(builtinName);
                list.appendChild(builtinHeader);
            }
            for (const tool of group.tools) {
                list.appendChild(buildToolRow(tool, active.has(tool.name)));
            }
        }
    }
    panel.appendChild(list);

    const hint = el('p', 'tools-hint');
    hint.textContent = t('tools.nextTurn');
    panel.appendChild(hint);
    return panel;
}

/** One checkbox row: name + optional exposure badge + description. */
function buildToolRow(tool: ToolDetailInfo, isActive: boolean): HTMLElement {
    const row = el('label', `tools-item${isActive ? ' active' : ''}`);
    row.dataset.toolName = tool.name;
    const toggle = el('input', 'tools-item-toggle') as HTMLInputElement;
    toggle.type = 'checkbox';
    toggle.checked = isActive;
    toggle.dataset.toolName = tool.name;
    toggle.setAttribute('aria-label', tool.label ?? tool.name);
    row.appendChild(toggle);
    const main = el('span', 'tools-item-main');
    const nameRow = el('span', 'tools-item-name-row');
    const name = el('span', 'tools-item-name');
    name.textContent = tool.label ?? tool.name;
    nameRow.appendChild(name);
    if (tool.exposure && tool.exposure !== 'direct') {
        const badge = el('span', `tools-item-exposure tools-item-exposure-${tool.exposure}`);
        badge.textContent = tool.exposure;
        nameRow.appendChild(badge);
    }
    main.appendChild(nameRow);
    if (tool.description) {
        const desc = el('span', 'tools-item-desc');
        desc.textContent = tool.description;
        desc.title = tool.description;
        main.appendChild(desc);
    }
    row.appendChild(main);
    return row;
}

interface ToolGroup {
    /** `undefined` for the built-in (non-namespaced) group. */
    namespace?: string;
    description?: string;
    tools: ToolDetailInfo[];
}

/** Group tools by namespace, preserving first-seen order; unnamed tools lead. */
export function groupByNamespace(tools: readonly ToolDetailInfo[]): ToolGroup[] {
    const groups: ToolGroup[] = [];
    const byName = new Map<string, ToolGroup>();
    let builtin: ToolGroup | undefined;
    for (const tool of tools) {
        if (!tool.namespace) {
            builtin ??= { tools: [] };
            builtin.tools.push(tool);
            continue;
        }
        let group = byName.get(tool.namespace);
        if (!group) {
            group = { namespace: tool.namespace, description: tool.namespaceDescription, tools: [] };
            byName.set(tool.namespace, group);
            groups.push(group);
        }
        group.tools.push(tool);
    }
    return builtin ? [builtin, ...groups] : groups;
}
