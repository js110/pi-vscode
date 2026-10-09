import type { ExtensionUiDialog, SessionTreeEntryInfo } from '../../shared/protocol';
import { el } from '../dom';
import { t } from '../../shared/i18n';

export function buildSessionTreePanel(entries: SessionTreeEntryInfo[], query: string): HTMLElement {
    const panel = el('section', 'native-panel tree-panel');
    panel.id = 'tree-panel';
    panel.setAttribute('aria-label', t('tree.title'));
    const header = el('div', 'native-panel-header');
    const title = el('strong'); title.textContent = t('tree.title'); header.appendChild(title);
    const refresh = el('button', 'icon-btn'); refresh.dataset.action = 'refresh'; refresh.textContent = '↻'; refresh.title = t('native.refresh'); header.appendChild(refresh);
    const close = el('button', 'icon-btn'); close.dataset.action = 'close'; close.textContent = '×'; close.title = t('native.close'); header.appendChild(close);
    panel.appendChild(header);
    const search = el('input', 'native-search') as HTMLInputElement;
    search.type = 'search'; search.value = query; search.placeholder = t('tree.search'); search.setAttribute('aria-label', t('tree.search')); panel.appendChild(search);
    const controls = el('div', 'tree-controls');
    const label = el('label');
    const summarize = el('input') as HTMLInputElement; summarize.type = 'checkbox'; summarize.id = 'tree-summarize';
    label.append(summarize, document.createTextNode(t('tree.summarize'))); controls.appendChild(label);
    const instructions = el('textarea', 'native-search') as HTMLTextAreaElement;
    instructions.id = 'tree-instructions'; instructions.rows = 2; instructions.placeholder = t('tree.instructions'); instructions.setAttribute('aria-label', t('tree.instructions'));
    controls.appendChild(instructions); panel.appendChild(controls);
    const list = el('div', 'tree-list'); list.setAttribute('role', 'tree');
    const needle = query.toLocaleLowerCase().trim();
    const matching = entries.filter(entry => !needle || `${entry.text} ${entry.label ?? ''} ${entry.kind}`.toLocaleLowerCase().includes(needle));
    if (!matching.length) { const empty = el('p', 'native-empty'); empty.textContent = t(entries.length ? 'tree.noResults' : 'tree.empty'); list.appendChild(empty); }
    for (const entry of matching) {
        const row = el('div', `tree-entry${entry.current ? ' current' : ''}`);
        row.dataset.entryId = entry.id; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(entry.depth + 1)); row.setAttribute('aria-selected', String(entry.current));
        row.style.setProperty('--tree-depth', String(Math.min(entry.depth, 12)));
        const navigate = el('button', 'tree-navigate') as HTMLButtonElement; navigate.dataset.action = 'navigate'; navigate.disabled = entry.current;
        const kind = el('span', 'tree-kind'); kind.textContent = entry.current ? t('tree.current') : entry.kind;
        const text = el('span', 'tree-text'); text.textContent = entry.label || entry.text.replace(/\s+/g, ' ').slice(0, 180) || entry.kind;
        navigate.append(kind, text); navigate.title = entry.text || entry.id;
        const rename = el('button', 'icon-btn tree-label'); rename.dataset.action = 'label'; rename.title = t('tree.label'); rename.textContent = '✎';
        row.append(navigate, rename); list.appendChild(row);
    }
    panel.appendChild(list);
    return panel;
}

export function buildExtensionDialog(dialog: ExtensionUiDialog): HTMLElement {
    const panel = el('section', 'native-panel extension-dialog');
    panel.id = 'extension-dialog'; panel.dataset.requestId = dialog.id; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', dialog.title);
    const title = el('strong', 'native-panel-header'); title.textContent = dialog.title; panel.appendChild(title);
    if (dialog.message) { const text = el('p', 'native-empty'); text.textContent = dialog.message; panel.appendChild(text); }
    if (dialog.kind === 'select') {
        const options = el('div', 'extension-options');
        for (const value of dialog.options ?? []) { const button = el('button', 'native-option'); button.textContent = value; button.dataset.value = value; options.appendChild(button); }
        panel.appendChild(options);
    } else if (dialog.kind !== 'confirm') {
        const input = dialog.kind === 'editor' ? document.createElement('textarea') : document.createElement('input');
        input.className = 'native-search'; input.value = dialog.value ?? ''; input.setAttribute('aria-label', dialog.title); panel.appendChild(input);
    }
    const actions = el('div', 'native-actions');
    if (dialog.kind !== 'select') { const accept = el('button', 'native-option primary'); accept.dataset.action = 'accept'; accept.textContent = t('native.confirm'); actions.appendChild(accept); }
    const cancel = el('button', 'native-option'); cancel.dataset.action = 'cancel'; cancel.textContent = t('native.cancel'); actions.appendChild(cancel);
    panel.appendChild(actions);
    return panel;
}
