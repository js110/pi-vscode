// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { el, escHtml } from '../../../webview/dom';
import {
    renderMarkdown,
    prepareMarkdown,
    buildWelcome,
    buildThinkingBlock,
    buildDiffCard,
    buildToolCard,
    buildToolCardHeader,
    buildMessageTree,
    buildMessageFooter,
    buildToolApprovalCard,
    buildApplyPreviewCard,
    buildChangedFilesSection,
    buildConfigBanner,
    applyMemoryBadge,
    buildModelItem,
    buildStreamingSkeleton,
    updateStreamingThinking,
    reconcileStreamingText,
} from '../../../webview/render/messages';

function toolCtx(overrides: Record<string, any> = {}) {
    return {
        allMessages: [
            { role: 'assistant', toolCalls: [{ id: 'tc1', name: 'bash', arguments: { command: 'ls' } }] },
        ],
        msgIndex: 1,
        approvalTraces: new Map<string, any>(),
        ...overrides,
    };
}

beforeAll(async () => {
    // renderMarkdown is synchronous; it needs the lazily-loaded markdown
    // chunk resolved first so hljs/marked behavior is asserted, not the
    // plain-escaped fallback.
    await prepareMarkdown();
});

function baseRenderState(overrides: Record<string, any> = {}) {
    return {
        messages: [] as any[],
        isStreaming: false,
        fileChanges: [] as any[],
        imageCache: {} as Record<string, string>,
        rollbackPoint: null as number | null,
        approvalTraces: new Map<string, any>(),
        ...overrides,
    };
}

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
        expect(html).toContain('<span class="hljs-keyword">const</span>');
        expect(html).toContain('<span class="hljs-number">1</span>');
    });

    it('adds an apply button for known languages and omits it for plain text', () => {
        const ts = renderMarkdown('```ts\nconst x = 1;\n```');
        expect(ts).toContain('apply-btn');
        expect(ts).toContain('data-apply-lang="ts"');
        const plain = renderMarkdown('```\njust text\n```');
        expect(plain).not.toContain('apply-btn');
        expect(plain).toContain('just text');
    });

    it('escapes code that highlight.js does not know how to tokenize', () => {
        const html = renderMarkdown('```ts\n<script>&amp;\n```');
        expect(html).toContain('&lt;script&gt;');
    });

    it('collapses long code blocks with a toggle', () => {
        const code = Array.from({ length: 25 }, (_, i) => `line${i}`).join('\n');
        const html = renderMarkdown('```js\n' + code + '\n```');
        expect(html).toContain('code-block-collapsed');
        expect(html).toContain('code-block-toggle');
        const short = renderMarkdown('```js\nconst x = 1;\n```');
        expect(short).not.toContain('code-block-toggle');
    });

    it('returns empty string for empty input', () => {
        expect(renderMarkdown('')).toBe('');
    });
});

describe('buildWelcome', () => {
    it('builds a welcome panel with headline + suggestion items', () => {
        const node = buildWelcome();
        expect(node.className).toContain('welcome');
        expect(node.querySelector('.welcome-title')?.textContent).toBe('Chat with Pi about your codebase');
        const items = node.querySelectorAll('.wi[data-suggestion]');
        expect(items.length).toBe(4);
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

describe('buildToolCard (settled tool result)', () => {
    it('renders an expandable card with a body for output-bearing tools', () => {
        const msg = { role: 'toolResult', toolName: 'bash', toolCallId: 'tc1', content: 'src\nbin\n' };
        const node = buildToolCard(msg, toolCtx());
        expect(node.className).toBe('tool-card-wrapper');
        const details = node.querySelector('.tool-card') as HTMLElement;
        expect(details.tagName).toBe('DETAILS');
        expect(details.className).toContain('tool-expandable');
        // label is derived from the matching assistant tool call arguments
        expect(details.querySelector('.tool-name')?.textContent).toBe('ls');
        expect(node.querySelector('.tool-result')?.textContent).toContain('src');
        expect(node.querySelector('.tool-expand-arrow')).not.toBeNull();
    });

    it('renders a compact clickable card for read tools', () => {
        const msg = { role: 'toolResult', toolName: 'read', toolCallId: 'tc2' };
        const allMessages = [{ role: 'assistant', toolCalls: [{ id: 'tc2', name: 'read', arguments: { path: 'src/a.ts' } }] }];
        const node = buildToolCard(msg, { allMessages, msgIndex: 1, approvalTraces: new Map() });
        const card = node.querySelector('.tool-card') as HTMLElement;
        expect(card.className).toContain('tool-clickable');
        expect(card.dataset.filepath).toBe('src/a.ts');
        expect(node.querySelector('.tool-result')).toBeNull();
    });

    it('marks errored tools with an error status', () => {
        const msg = { role: 'toolResult', toolName: 'bash', toolCallId: 'tc1', isError: true, content: 'boom' };
        const node = buildToolCard(msg, toolCtx());
        expect(node.querySelector('.tool-status')?.classList.contains('error')).toBe(true);
    });

    it('injects the approval-memory badge when a trace exists', () => {
        const traces = new Map<string, any>([['tc1', 'session']]);
        const node = buildToolCard(
            { role: 'toolResult', toolName: 'bash', toolCallId: 'tc1', content: 'x' },
            toolCtx({ approvalTraces: traces }),
        );
        expect(node.querySelector('.memory-badge')).not.toBeNull();
    });
});

describe('buildToolCardHeader', () => {
    it('builds a tool header with icon, name and status', () => {
        const node = buildToolCardHeader('read', 'Read src/a.ts', '<span class="tool-status pending">Awaiting</span>');
        expect(node.className).toBe('tool-header');
        expect(node.querySelector('.tool-name')?.textContent).toBe('Read src/a.ts');
        expect(node.querySelector('.tool-icon')).not.toBeNull();
        expect(node.querySelector('.tool-status')?.className).toContain('pending');
    });
});

describe('applyMemoryBadge', () => {
    it('inserts the badge when a trace exists', () => {
        const wrapper = document.createElement('div');
        wrapper.appendChild(buildToolCardHeader('bash', 'ls', ''));
        applyMemoryBadge(wrapper, 'tc1', new Map<string, any>([['tc1', 'global']]));
        expect(wrapper.querySelector('.memory-badge')?.textContent).toBe('memory · all tabs');
    });

    it('is a no-op without a trace', () => {
        const wrapper = document.createElement('div');
        wrapper.appendChild(buildToolCardHeader('bash', 'ls', ''));
        applyMemoryBadge(wrapper, 'tc1', new Map());
        expect(wrapper.querySelector('.memory-badge')).toBeNull();
    });
});

describe('buildMessageFooter', () => {
    it('shows the next assistant input tokens after a user message', () => {
        const footer = buildMessageFooter(
            { role: 'user', content: 'hi', timestamp: 1000 },
            [
                { role: 'user', content: 'hi', timestamp: 1000 },
                { role: 'assistant', content: 'ok', usage: { input: 1500 } },
            ],
            0,
        );
        expect(footer?.textContent).toContain('1,500');
    });

    it('shows output tokens for assistant messages', () => {
        const footer = buildMessageFooter(
            { role: 'assistant', content: 'ok', timestamp: 2000, usage: { output: 300 } },
            [],
            0,
        );
        expect(footer?.textContent).toContain('300');
    });

    it('returns null for tool messages and empty metadata', () => {
        expect(buildMessageFooter({ role: 'toolResult', content: 'x' }, [], 0)).toBeNull();
        expect(buildMessageFooter({ role: 'assistant', content: 'x' }, [], 0)).toBeNull();
    });
});

describe('buildMessageTree', () => {
    it('returns a welcome panel when there are no messages and not streaming', () => {
        const nodes = buildMessageTree(baseRenderState());
        expect(nodes.length).toBe(1);
        expect(nodes[0].className).toContain('welcome');
    });

    it('renders nothing while streaming a fresh session', () => {
        const nodes = buildMessageTree(baseRenderState({ isStreaming: true }));
        expect(nodes.length).toBe(0);
    });

    it('renders user and assistant message groups', () => {
        const nodes = buildMessageTree(baseRenderState({
            messages: [
                { role: 'user', content: 'hello', timestamp: 1000 },
                { role: 'assistant', content: 'hi there', timestamp: 2000 },
            ],
        }));
        expect(nodes.length).toBe(2);
        expect(nodes[0].className).toContain('message-group-user');
        expect(nodes[0].querySelector('.message-user')?.textContent).toContain('hello');
        expect(nodes[1].className).toContain('message-group-assistant');
        expect(nodes[1].querySelector('.message-assistant')?.textContent).toContain('hi there');
    });

    it('renders user images resolved through the image cache', () => {
        const nodes = buildMessageTree(baseRenderState({
            messages: [
                { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', assetId: 'a1' }] },
            ],
            imageCache: { a1: 'data:image/png;base64,xxx' },
        }));
        const img = nodes[0].querySelector('.message-image') as HTMLImageElement;
        expect(img?.src).toBe('data:image/png;base64,xxx');
    });

    it('turns matched edit tool results into diff cards', () => {
        const nodes = buildMessageTree(baseRenderState({
            messages: [
                { role: 'assistant', content: 'editing', toolCalls: [{ id: 'tc1', name: 'edit', arguments: { path: 'a.ts' } }] },
                { role: 'toolResult', toolName: 'edit', toolCallId: 'tc1', content: 'done' },
            ],
            fileChanges: [{ filePath: 'a.ts', toolCallId: 'tc1', toolName: 'edit', isNew: false, addedLines: 1, removedLines: 0, turnIndex: 0 }],
        }));
        const diff = nodes[1].querySelector('.diff-card');
        expect(diff).not.toBeNull();
    });

    it('dims messages after the rollback point and places the redo anchor', () => {
        const nodes = buildMessageTree(baseRenderState({
            messages: [
                { role: 'user', content: 'first', timestamp: 1000 },
                { role: 'assistant', content: 'reply', timestamp: 2000 },
                { role: 'user', content: 'second', timestamp: 3000 },
            ],
            rollbackPoint: 1,
        }));
        expect(nodes.length).toBe(4);
        expect(nodes[0].className).not.toContain('dimmed');
        expect(nodes[2].className).toContain('dimmed');
        expect(nodes[3].className).toContain('redo-anchor');
    });
});

describe('buildToolApprovalCard', () => {
    it('builds a pending card with actions for a dangerous tool', () => {
        const node = buildToolApprovalCard({ toolCallId: 'tcA', toolName: 'bash', args: { command: 'ls' } });
        expect(node.id).toBe('approval-tcA');
        expect(node.querySelector('.tool-status')?.classList.contains('pending')).toBe(true);
        expect(node.querySelector('.approval-args')?.textContent).toBe('command: ls');
        expect(node.querySelector('.approval-btn.approve')?.getAttribute('data-toolcallid')).toBe('tcA');
        expect(node.querySelector('.approval-btn.reject')).not.toBeNull();
        // shell tools must never offer a "remember" action
        expect(node.querySelector('.remember-split')).toBeNull();
    });

    it('offers remember options for non-dangerous tools', () => {
        const node = buildToolApprovalCard({ toolCallId: 'tcB', toolName: 'read', args: { path: 'a.ts' } });
        expect(node.querySelector('.remember-split')).not.toBeNull();
        expect(node.querySelector('.remember-option[data-scope="session"]')).not.toBeNull();
        expect(node.querySelector('.remember-option[data-scope="global"]')).not.toBeNull();
    });
});

describe('buildApplyPreviewCard', () => {
    it('builds a preview card with stats and confirm/cancel actions', () => {
        const node = buildApplyPreviewCard({
            previewId: 'p1',
            targetPath: 'src/b.ts',
            isNew: true,
            addedLines: 3,
            removedLines: 1,
            diff: '@@ -1 +1,3 @@\n+a\n+b\n-c',
            code: 'a\nb\n',
        });
        expect(node.id).toBe('apply-preview-p1');
        expect(node.className).toContain('apply-preview-card');
        expect(node.querySelector('.diff-new-badge')).not.toBeNull();
        expect(node.querySelector('.diff-stat-add')?.textContent).toBe('+3');
        expect(node.querySelector('.diff-stat-del')?.textContent).toBe('-1');
        expect(node.querySelector('.apply-confirm')?.getAttribute('data-previewid')).toBe('p1');
        expect(node.querySelector('.apply-cancel')).not.toBeNull();
    });
});

describe('buildChangedFilesSection', () => {
    const changes = [
        { filePath: 'src/a.ts', toolCallId: 't1', toolName: 'edit', isNew: false, addedLines: 2, removedLines: 1, turnIndex: 0 },
    ];

    it('shows an undo button when no rollback point exists', () => {
        const node = buildChangedFilesSection(changes, null);
        expect(node.querySelector('#btn-undo')).not.toBeNull();
        expect(node.querySelector('#btn-redo')).toBeNull();
        const item = node.querySelector('.changed-file-item') as HTMLElement;
        expect(item.dataset.filepath).toBe('src/a.ts');
        expect(node.querySelector('.cf-stat-add')?.textContent).toBe('+2');
        expect(node.querySelector('.cf-stat-del')?.textContent).toBe('-1');
    });

    it('shows a redo button when a rollback point exists', () => {
        const node = buildChangedFilesSection(changes, 1);
        expect(node.querySelector('#btn-redo')).not.toBeNull();
        expect(node.querySelector('#btn-undo')).toBeNull();
    });
});

describe('buildConfigBanner', () => {
    it('returns null without a config', () => {
        expect(buildConfigBanner(undefined)).toBeNull();
    });

    it('shows stats and a refresh button for a healthy config', () => {
        const node = buildConfigBanner({ status: 'ok', agentDir: '/x', providers: ['p'], models: ['m'], skills: ['s'] } as any);
        expect(node?.querySelector('.config-stats')).not.toBeNull();
        expect(node?.querySelector('.config-refresh')).not.toBeNull();
    });

    it('shows a missing-dir issue for not-found configs', () => {
        const node = buildConfigBanner({ status: 'not-found', agentDir: '/x' } as any);
        expect(node?.querySelector('.config-issue')).not.toBeNull();
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

describe('streaming region', () => {
    it('buildStreamingSkeleton produces the thinking + text structure', () => {
        const node = buildStreamingSkeleton();
        expect(node.className).toContain('message message-assistant');
        expect(node.querySelector('#streaming-thinking')).not.toBeNull();
        expect(node.querySelector('#streaming-text')).not.toBeNull();
        expect((node.querySelector('#streaming-thinking') as HTMLElement).style.display).toBe('none');
    });

    it('updateStreamingThinking hides the block without thinking and shows it with', () => {
        const thinkingEl = buildStreamingSkeleton().querySelector('#streaming-thinking') as HTMLElement;
        updateStreamingThinking(thinkingEl, { thinking: '', isThinking: false, durationSec: 0 });
        expect(thinkingEl.style.display).toBe('none');

        updateStreamingThinking(thinkingEl, { thinking: '**plan**', isThinking: true, durationSec: 2 });
        expect(thinkingEl.style.display).toBe('');
        expect(thinkingEl.classList.contains('active')).toBe(true);
        expect(thinkingEl.querySelector('.thinking-content')?.innerHTML).toContain('<strong>plan</strong>');
        expect(thinkingEl.querySelector('.thinking-label')?.textContent).not.toBe('');
    });

    it('updateStreamingThinking toggles active off for non-thinking', () => {
        const thinkingEl = buildStreamingSkeleton().querySelector('#streaming-thinking') as HTMLElement;
        updateStreamingThinking(thinkingEl, { thinking: 'x', isThinking: true, durationSec: 1 });
        updateStreamingThinking(thinkingEl, { thinking: 'x', isThinking: false, durationSec: 1 });
        expect(thinkingEl.classList.contains('active')).toBe(false);
    });

    it('reconcileStreamingText renders blocks incrementally', () => {
        const textEl = document.createElement('div');
        reconcileStreamingText(textEl, 'one block only');
        expect(textEl.children.length).toBe(1);
        expect(textEl.textContent).toContain('one block only');

        reconcileStreamingText(textEl, 'one block only\n\nsecond block');
        expect(textEl.children.length).toBe(2);
        expect(textEl.children[1].textContent).toContain('second block');
    });

    it('reconcileStreamingText prunes removed blocks', () => {
        const textEl = document.createElement('div');
        reconcileStreamingText(textEl, 'a\n\nb\n\nc');
        expect(textEl.children.length).toBe(3);
        reconcileStreamingText(textEl, 'a\n\nb');
        expect(textEl.children.length).toBe(2);
        expect(textEl.children[1].textContent).toContain('b');
    });

    it('reconcileStreamingText is idempotent on repeated input', () => {
        const textEl = document.createElement('div');
        reconcileStreamingText(textEl, 'same');
        const before = textEl.children[0].innerHTML;
        reconcileStreamingText(textEl, 'same');
        expect(textEl.children[0].innerHTML).toBe(before);
        expect(textEl.children.length).toBe(1);
    });

    it('reconcileStreamingText only patches the changed tail', () => {
        const textEl = document.createElement('div');
        reconcileStreamingText(textEl, 'prefix\n\nold tail');
        const firstBlockMarkup = textEl.children[0].innerHTML;
        const secondBlockMarkup = textEl.children[1].innerHTML;

        reconcileStreamingText(textEl, 'prefix\n\nnew tail');
        expect(textEl.children[0].innerHTML).toBe(firstBlockMarkup);
        expect(textEl.children[0].textContent).toContain('prefix');
        expect(textEl.children[1].textContent).toContain('new tail');
        expect(textEl.children.length).toBe(2);
        expect(secondBlockMarkup).not.toBe(textEl.children[1].innerHTML);
    });

    it('a fresh element starts with a fresh block cache', () => {
        const a = document.createElement('div');
        const b = document.createElement('div');
        reconcileStreamingText(a, 'x\n\ny');
        reconcileStreamingText(b, 'x\n\ny');
        expect(a.children.length).toBe(2);
        expect(b.children.length).toBe(2);
    });
});