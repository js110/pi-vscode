import type { ApprovalRuleInfo, SettingsClientMessage, SettingsServerMessage, SettingsData, SkillInfo } from '../shared/protocol';
import { t, setLang } from '../shared/i18n';
import { el, escHtml } from './dom';
import { escAttr } from '../shared/webview-text';
import { showToast as presentToast } from './toast';

declare function acquireVsCodeApi(): {
    postMessage(message: SettingsClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();

let currentSettings: SettingsData | null = null;
let loadedSkills: SkillInfo[] = [];
let approvalRules: ApprovalRuleInfo[] = [];

window.addEventListener('message', (event) => {
    const msg = event.data as SettingsServerMessage;
    switch (msg.type) {
        case 'settings':
            currentSettings = msg.data;
            render(msg.data);
            break;
        case 'settingChanged':
            if (currentSettings) {
                (currentSettings as any)[msg.key] = msg.value;
                render(currentSettings);
            }
            break;
        case 'skills':
            loadedSkills = msg.skills;
            renderSkillsSection();
            break;
        case 'approvalRules':
            approvalRules = msg.rules;
            renderApprovalSection();
            break;
        case 'langChanged':
            setLang(msg.lang);
            if (currentSettings) render(currentSettings);
            renderApprovalSection();
            break;
        case 'error':
            showToast(msg.message, 'error');
            break;
    }
});

function render(data: SettingsData): void {
    const app = document.getElementById('settings-app')!;
    app.innerHTML = '';

    const container = el('div', 'settings-container');

    const header = el('div', 'settings-header');
    header.innerHTML = `<h1>${escHtml(t('settings.title'))}</h1>`;
    container.appendChild(header);

    container.appendChild(buildSection(t('settings.section.api'), [
        buildSelect('apiProvider', t('settings.provider'), data.apiProvider, [
            { value: '', label: t('settings.autoDetect') },
            { value: 'anthropic', label: 'Anthropic' },
            { value: 'openai', label: 'OpenAI' },
            { value: 'google', label: 'Google Gemini' },
            { value: 'deepseek', label: 'DeepSeek' },
        ], t('settings.providerDesc')),
        buildApiKeyField(data),
        buildAuthIndicator(data.authMethod),
    ]));

    container.appendChild(buildSection(t('settings.section.model'), [
        buildTextInput('defaultModel', t('settings.defaultModel'), data.defaultModel,
            t('settings.defaultModelDesc')),
        buildSelect('thinkingLevel', t('settings.thinkingLevel'), data.thinkingLevel, [
            { value: 'off', label: t('settings.think.off') },
            { value: 'minimal', label: t('settings.think.minimal') },
            { value: 'low', label: t('settings.think.low') },
            { value: 'medium', label: t('settings.think.medium') },
            { value: 'high', label: t('settings.think.high') },
        ], t('settings.thinkingLevelDesc')),
    ]));

    container.appendChild(buildSection(t('settings.section.tools'), [
        buildToggle('autoApproveTools', t('settings.autoApprove'), data.autoApproveTools,
            t('settings.autoApproveDesc')),
        buildTextarea('allowedTools', t('settings.allowedTools'), data.allowedTools.join(', '),
            t('settings.allowedToolsDesc')),
    ]));

    const approvalSection = buildSection(t('settings.section.approval'), [buildApprovalPlaceholder()]);
    approvalSection.id = 'approval-section';
    container.appendChild(approvalSection);

    container.appendChild(buildSection(t('settings.section.session'), [
        buildToggle('autoSaveSessions', t('settings.autoSave'), data.autoSaveSessions,
            t('settings.autoSaveDesc')),
        buildTextInput('sessionStoragePath', t('settings.sessionPath'), data.sessionStoragePath,
            t('settings.sessionPathDesc')),
        buildRange('contextUsageWarningThreshold', t('settings.contextWarning'), data.contextUsageWarningThreshold, 0, 100,
            t('settings.contextWarningDesc', { n: data.contextUsageWarningThreshold })),
    ]));

    const skillsSection = buildSection(t('settings.section.skills'), [buildSkillsPlaceholder()], true);
    skillsSection.id = 'skills-section';
    container.appendChild(skillsSection);

    container.appendChild(buildSection(t('settings.section.credits'), [
        buildCredits(),
    ]));

    app.appendChild(container);
    bindEvents();
    renderSkillsSection();
}

function buildSection(title: string, children: HTMLElement[], collapsed = false): HTMLElement {
    const section = el('div', 'settings-section');
    if (collapsed) { section.classList.add('collapsed'); }
    const heading = el('h2', 'section-title');
    heading.textContent = title;
    if (collapsed) {
        heading.classList.add('section-title-collapsible');
        heading.addEventListener('click', () => {
            section.classList.toggle('collapsed');
        });
    }
    section.appendChild(heading);
    for (const child of children) {
        section.appendChild(child);
    }
    return section;
}

function buildSelect(key: string, label: string, value: string, options: { value: string; label: string }[], description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <select id="setting-${key}" class="setting-select" data-key="${key}">
            ${options.map(o => `<option value="${escAttr(o.value)}" ${o.value === value ? 'selected' : ''}>${escHtml(o.label)}</option>`).join('')}
        </select>
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildTextInput(key: string, label: string, value: string, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <input type="text" id="setting-${key}" class="setting-input" data-key="${key}" value="${escAttr(value)}" placeholder="${escHtml(description.split('.')[0])}">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildTextarea(key: string, label: string, value: string, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <input type="text" id="setting-${key}" class="setting-input" data-key="${key}" value="${escAttr(value)}" placeholder="${escAttr(t('settings.allowedToolsPlaceholder'))}">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildToggle(key: string, label: string, value: boolean, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-toggle-row">
            <label class="toggle-label" for="setting-${key}">
                <span class="toggle-switch">
                    <input type="checkbox" id="setting-${key}" data-key="${key}" ${value ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </span>
                <span>${escHtml(label)}</span>
            </label>
        </div>
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildRange(key: string, label: string, value: number, min: number, max: number, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
            <span class="range-value" id="range-val-${key}">${value}%</span>
        </div>
        <input type="range" id="setting-${key}" class="setting-range" data-key="${key}" min="${min}" max="${max}" value="${value}">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildApiKeyField(data: SettingsData): HTMLElement {
    const row = el('div', 'setting-row');
    const provider = data.apiProvider || 'provider';

    if (data.apiKeySet) {
        row.innerHTML = `
            <div class="setting-label-row">
                <label>${escHtml(t('settings.apiKey'))}</label>
                <span class="key-status set">${escHtml(t('settings.keyStored'))}</span>
            </div>
            <div class="api-key-actions">
                <button class="setting-btn secondary" id="btn-change-key">${escHtml(t('settings.change'))}</button>
                <button class="setting-btn danger" id="btn-clear-key">${escHtml(t('settings.remove'))}</button>
            </div>
            <p class="setting-description">${escHtml(t('settings.keyStoredDesc'))}</p>
        `;
    } else {
        row.innerHTML = `
            <div class="setting-label-row">
                <label for="api-key-input">${escHtml(t('settings.apiKey'))}</label>
                <span class="key-status unset">${escHtml(t('settings.noKey'))}</span>
            </div>
            <div class="api-key-input-row">
                <input type="password" id="api-key-input" class="setting-input" placeholder="${escAttr(t('settings.enterKey'))}">
                <button class="setting-btn primary" id="btn-save-key">${escHtml(t('settings.save'))}</button>
            </div>
            <p class="setting-description">${escHtml(t('settings.keySecureDesc'))}</p>
        `;
    }
    return row;
}

function buildAuthIndicator(method: SettingsData['authMethod']): HTMLElement {
    const row = el('div', 'setting-row auth-indicator');
    const labels: Record<string, string> = {
        env: t('settings.authEnv'),
        'pi-login': t('settings.authLogin'),
        manual: t('settings.authKey'),
        none: t('settings.authNone'),
    };
    const icons: Record<string, string> = {
        env: '&#10003;',
        'pi-login': '&#10003;',
        manual: '&#10003;',
        none: '&#10007;',
    };
    const cls = method === 'none' ? 'auth-none' : 'auth-ok';
    row.innerHTML = `
        <div class="auth-status ${cls}">
            <span class="auth-icon">${icons[method]}</span>
            <span>${labels[method]}</span>
        </div>
    `;
    return row;
}

function buildCredits(): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `<p class="setting-description">${t('settings.credits')}</p>`;
    return row;
}

function buildSkillsPlaceholder(): HTMLElement {
    const row = el('div', 'setting-row');
    row.id = 'skills-list';
    row.innerHTML = `<p class="setting-description">${escHtml(t('settings.skillsLoading'))}</p>`;
    return row;
}

function buildApprovalPlaceholder(): HTMLElement {
    const row = el('div', 'setting-row');
    row.id = 'approval-rules';
    row.innerHTML = `<p class="setting-description">${escHtml(t('settings.approvalLoading'))}</p>`;
    return row;
}

function renderApprovalSection(): void {
    const container = document.getElementById('approval-rules');
    if (!container) return;

    container.innerHTML = '';

    const description = el('p', 'setting-description');
    description.textContent = t('settings.approvalDesc');
    container.appendChild(description);

    if (approvalRules.length === 0) {
        const empty = el('p', 'setting-description approval-empty');
        empty.textContent = t('settings.approvalEmpty');
        container.appendChild(empty);
        return;
    }

    const list = el('div', 'approval-rules-list');
    for (const rule of approvalRules) {
        const item = el('div', 'approval-rule-item');
        const name = el('span', 'approval-rule-tool');
        name.textContent = rule.tool;
        const date = el('span', 'approval-rule-date');
        date.textContent = t('settings.approvalSince', { date: formatDate(rule.createdAt) });
        const revoke = el('button', 'setting-btn danger approval-rule-revoke');
        revoke.textContent = t('settings.revoke');
        revoke.dataset.tool = rule.tool;
        item.append(name, date, revoke);
        list.appendChild(item);
    }
    container.appendChild(list);

    const clearRow = el('div', 'approval-clear-row');
    const clear = el('button', 'setting-btn secondary');
    clear.id = 'btn-clear-approval-rules';
    clear.textContent = t('settings.clearAll', { n: approvalRules.length });
    clearRow.appendChild(clear);
    container.appendChild(clearRow);

    bindApprovalEvents();
}

function formatDate(ts: number): string {
    try {
        return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
        return '';
    }
}

function bindApprovalEvents(): void {
    document.querySelectorAll('.approval-rule-revoke').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tool = (btn as HTMLElement).dataset.tool!;
            vscode.postMessage({ type: 'revokeApprovalRule', tool });
        });
    });

    const clearBtn = document.getElementById('btn-clear-approval-rules');
    clearBtn?.addEventListener('click', () => {
        vscode.postMessage({ type: 'clearApprovalRules' });
    });
}

function renderSkillsSection(): void {
    const container = document.getElementById('skills-list');
    if (!container) return;

    if (loadedSkills.length === 0) {
        container.innerHTML = `<p class="setting-description">${t('settings.skillsEmpty')}</p>`;
        return;
    }

    container.innerHTML = loadedSkills.map(skill => {
        const invocation = skill.disableModelInvocation
            ? `<span class="skill-badge">${escHtml(t('settings.manualOnly'))}</span>`
            : '';
        return `<div class="skill-card">
            <div class="skill-card-header">
                <span class="skill-card-name">/skill:${escHtml(skill.name)}</span>
                ${invocation}
            </div>
            ${skill.description ? `<p class="skill-card-desc">${escHtml(skill.description)}</p>` : ''}
            <p class="skill-card-path">${escHtml(skill.filePath)}</p>
            ${skill.source ? `<span class="skill-card-source">${escHtml(skill.source)}</span>` : ''}
        </div>`;
    }).join('');
}

function bindEvents(): void {
    document.querySelectorAll('.setting-select').forEach((select) => {
        select.addEventListener('change', () => {
            const key = (select as HTMLSelectElement).dataset.key!;
            const value = (select as HTMLSelectElement).value;
            vscode.postMessage({ type: 'updateSetting', key, value });
        });
    });

    document.querySelectorAll('.setting-input[data-key]').forEach((input) => {
        let debounce: ReturnType<typeof setTimeout>;
        input.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                const key = (input as HTMLInputElement).dataset.key!;
                let value: any = (input as HTMLInputElement).value;
                if (key === 'allowedTools') {
                    value = value.split(',').map((s: string) => s.trim()).filter(Boolean);
                }
                vscode.postMessage({ type: 'updateSetting', key, value });
            }, 500);
        });
    });

    document.querySelectorAll('input[type="checkbox"][data-key]').forEach((cb) => {
        cb.addEventListener('change', () => {
            const key = (cb as HTMLInputElement).dataset.key!;
            const value = (cb as HTMLInputElement).checked;
            vscode.postMessage({ type: 'updateSetting', key, value });
        });
    });

    document.querySelectorAll('.setting-range').forEach((range) => {
        range.addEventListener('input', () => {
            const key = (range as HTMLInputElement).dataset.key!;
            const value = parseInt((range as HTMLInputElement).value, 10);
            const label = document.getElementById(`range-val-${key}`);
            if (label) label.textContent = `${value}%`;
        });
        range.addEventListener('change', () => {
            const key = (range as HTMLInputElement).dataset.key!;
            const value = parseInt((range as HTMLInputElement).value, 10);
            vscode.postMessage({ type: 'updateSetting', key, value });
        });
    });

    const saveKeyBtn = document.getElementById('btn-save-key');
    saveKeyBtn?.addEventListener('click', () => {
        const input = document.getElementById('api-key-input') as HTMLInputElement;
        const key = input?.value?.trim();
        const provider = currentSettings?.apiProvider || '';
        if (!provider) {
            showToast(t('settings.toastSelectProvider'), 'error');
            return;
        }
        if (!key) {
            showToast(t('settings.toastEnterKey'), 'error');
            return;
        }
        vscode.postMessage({ type: 'setApiKey', provider, key });
    });

    const changeKeyBtn = document.getElementById('btn-change-key');
    changeKeyBtn?.addEventListener('click', () => {
        if (currentSettings) {
            currentSettings.apiKeySet = false;
            render(currentSettings);
        }
    });

    const clearKeyBtn = document.getElementById('btn-clear-key');
    clearKeyBtn?.addEventListener('click', () => {
        const provider = currentSettings?.apiProvider || '';
        if (provider) {
            vscode.postMessage({ type: 'clearApiKey', provider });
        }
    });

    const keybindingsLink = document.getElementById('btn-open-keybindings');
    keybindingsLink?.addEventListener('click', (e) => {
        e.preventDefault();
    });
}

function showToast(message: string, type: 'error' | 'info' = 'info'): void {
    presentToast({
        reuseId: 'toast',
        className: `toast toast-${type}`,
        hideClass: 'visible',
        message,
        durationMs: 3000,
    });
}

vscode.postMessage({ type: 'getSettings' });
vscode.postMessage({ type: 'getSkills' });
vscode.postMessage({ type: 'getApprovalRules' });
