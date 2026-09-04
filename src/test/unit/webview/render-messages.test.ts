// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { el, escHtml } from '../../../webview/dom';
import {
    renderMarkdown,
    buildWelcome,
    buildThinkingBlock,
    buildDiffCard,
    buildToolCard,
    buildModelItem,
} from '../../../webview/render/messages';

describe('dom helpers', () => {
    it('el creates an element with the given class', () => {
        const node = el('div', 'foo');
        expect(node.tagName).toBe('DIV');
        expect(node.className).toBe('foo');
    });

    it('escHtml escapes HTML special characters', () => {
        expect(escHtml('<script>&')).toBe('&lt;script&gt;&amp;');
    });
});

describe('renderMarkdown', () => {
    it('renders inline bold and emphasis', () => {
        expect(renderMarkdown('**bold** text')).toContain('<strong>bold</strong>');
    });

    it('renders fenced code blocks with a copy button', () => {
        const html = renderMarkdown('```ts\nconst x = 1;\n```');
        expect(html).toContain('copy-btn');
        expect(html).toContain('code-lang');
        expect(html).toContain('const x = 1;');
    });

    it('returns empty string for empty input', () => {
        expect(renderMarkdown('')).toBe('');
    });
});

describe('buildWelcome', () => {
    it('builds a welcome panel with title', () => {
        const node = buildWelcome();
        expect(node.className).toContain('welcome');
        expect(node.querySelector('.welcome-title')?.textContent).toBe('Pi Agent');
    });
});

describe('buildThinkingBlock', () => {
    it('labels active thinking blocks as Thinking...', () => {
        const node = buildThinkingBlock('working', true);
        expect(node.tagName).toBe('DETAILS');
        expect(node.className).toContain('active');
        expect(node.querySelector('.thinking-label')?.textContent).toBe('Thinking...');
    });

    it('labels completed blocks with a duration', () => {
        const node = buildThinkingBlock('done', false, 3);
        expect(node.querySelector('.thinking-label')?.textContent).toBe('Thought for 3 seconds');
    });

    it('labels completed blocks without duration as Thought', () => {
        const node = buildThinkingBlock('done', false);
        expect(node.querySelector('.thinking-label')?.textContent).toBe('Thought');
    });

    it('renders content as markdown', () => {
        const node = buildThinkingBlock('**hi**', false);
        expect(node.querySelector('.thinking-content')?.innerHTML).toContain('<strong>hi</strong>');
    });
});

describe('buildDiffCard', () => {
    const change = {
        filePath: 'src/a.ts',
        toolCallId: 'tc1',
        toolName: 'edit',
        isNew: false,
        addedLines: 2,
        removedLines: 1,
        turnIndex: 0,
    };

    it('builds a diff card with file metadata', () => {
        const node = buildDiffCard(change);
        const header = node.querySelector('.diff-file-header') as HTMLElement;
        expect(header.dataset.filepath).toBe('src/a.ts');
        expect(header.dataset.toolcallid).toBe('tc1');
        expect(node.querySelector('.diff-file-name')?.textContent).toBe('a.ts');
        expect(node.querySelector('.diff-stat-add')?.textContent).toBe('+2');
        expect(node.querySelector('.diff-stat-del')?.textContent).toBe('-1');
    });

    it('marks new files with a NEW badge', () => {
        const node = buildDiffCard({ ...change, isNew: true });
        expect(node.querySelector('.diff-new-badge')).not.toBeNull();
    });

    it('renders a diff view when a diff is present', () => {
        const node = buildDiffCard({ ...change, diff: '@@ -1,1 +1,2 @@\n-a\n+b\n+c' });
        expect(node.querySelector('.diff-view')).not.toBeNull();
    });

    it('appends a timestamp footer from the message', () => {
        const node = buildDiffCard(change, { timestamp: 1234567890 });
        expect(node.querySelector('.tool-footer')?.textContent).toBeTruthy();
    });
});

describe('buildToolCard', () => {
    it('renders tool name and status', () => {
        const tc = { name: 'bash', args: 'ls', _status: 'running' };
        const node = buildToolCard(tc);
        expect(node.className).toContain('tool-card');
        expect(node.querySelector('.tool-name')?.textContent).toBeTruthy();
        expect(node.querySelector('.tool-name')?.textContent).not.toBe('unknown');
    });

    it('renders a tool result when present', () => {
        const tc = { name: 'bash', args: 'ls', _status: 'done', _result: 'src\n' };
        const node = buildToolCard(tc);
        expect(node.querySelector('.tool-result')?.textContent).toContain('src');
    });

    it('does not render a result element when absent', () => {
        const node = buildToolCard({ name: 'bash', args: '' });
        expect(node.querySelector('.tool-result')).toBeNull();
    });
});

describe('buildModelItem', () => {
    it('marks the active model', () => {
        const m = { provider: 'p', id: 'm1', name: 'Model One' };
        const current = { provider: 'p', id: 'm1', name: 'Model One' };
        const node = buildModelItem(m, current);
        expect(node.className).toContain('active');
        expect(node.dataset.provider).toBe('p');
        expect(node.dataset.modelId).toBe('m1');
        expect(node.querySelector('.model-item-name')?.textContent).toBe('Model One');
        expect(node.querySelector('.model-item-check')?.textContent).toBe('\u2713');
    });

    it('omits the active state for a non-matching model', () => {
        const m = { provider: 'p', id: 'm1', name: 'Model One' };
        const node = buildModelItem(m, { provider: 'p', id: 'other', name: 'Other' });
        expect(node.className).not.toContain('active');
        expect(node.querySelector('.model-item-check')?.textContent).not.toContain('\u2713');
    });
});
