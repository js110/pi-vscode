// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildSessionTreePanel, buildExtensionDialog } from '../../../webview/render/native-panels';
import { buildToolOutput, buildToolCard } from '../../../webview/render/messages';

describe('native surfaces', () => {
    it('shows current branch, nesting, labels, and safe search results', () => {
        const entries = [
            { id: 'root', parentId: null, depth: 0, kind: 'user', text: 'root', current: false },
            { id: 'child', parentId: 'root', depth: 1, kind: 'assistant', text: 'answer', label: '<script>label</script>', current: true },
        ];
        const panel = buildSessionTreePanel(entries, 'label');
        expect(panel.querySelectorAll('[role=treeitem]')).toHaveLength(2);
        const row = panel.querySelector('[data-entry-id=child]')!;
        expect(row.getAttribute('aria-level')).toBe('2');
        expect(row.getAttribute('aria-selected')).toBe('true');
        expect(panel.querySelector('script')).toBeNull();
        expect(row.querySelector<HTMLButtonElement>('.tree-navigate')!.disabled).toBe(true);
        expect(panel.querySelector('[data-entry-id=root]')!.classList.contains('tree-ancestor')).toBe(true);
    });
    it('hides internal records, compresses linear depth and expands search through collapsed branches', () => {
        const entries = [
            { id: 'root', parentId: null, depth: 0, kind: 'user', text: 'Question', current: false },
            { id: 'tool', parentId: 'root', depth: 1, kind: 'toolResult', text: 'tool log', current: false },
            { id: 'answer', parentId: 'tool', depth: 2, kind: 'assistant', text: 'Answer A', current: true },
            { id: 'other', parentId: 'root', depth: 1, kind: 'assistant', text: 'Answer B', current: false },
        ];
        const panel = buildSessionTreePanel(entries, '');
        expect(panel.querySelector('[data-entry-id=tool]')).toBeNull();
        expect(panel.querySelector<HTMLElement>('[data-entry-id=answer]')!.style.getPropertyValue('--tree-depth')).toBe('1');
        expect(panel.querySelector<HTMLDetailsElement>('.tree-controls')!.open).toBe(false);
        const folded = buildSessionTreePanel(entries, '', new Set(['root']));
        expect(folded.querySelectorAll('[role=treeitem]')).toHaveLength(1);
        expect(folded.querySelector('[role=treeitem]')!.getAttribute('aria-expanded')).toBe('false');
        const searched = buildSessionTreePanel(entries, 'Answer A', new Set(['root']));
        expect(searched.querySelector('[data-entry-id=answer]')).not.toBeNull();
        expect(searched.querySelector('[data-entry-id=other]')).toBeNull();
        expect(searched.querySelector('[data-entry-id=root]')).not.toBeNull();
    });
    it('preserves a multiline extension draft without interpreting markup', () => {
        const panel = buildExtensionDialog({ id: 'editor', kind: 'editor', title: 'Edit', value: '<img>\nsecond line' });
        expect(panel.querySelector('textarea')!.value).toBe('<img>\nsecond line');
        expect(panel.querySelector('img')).toBeNull();
    });
    it('renders multiple outputs, asset images, and persisted nested call durations', () => {
        const output = buildToolOutput({ content: [{ type: 'text', text: '<b>first</b>' }, { type: 'image', assetId: 'img1' }, { type: 'text', text: 'second' }],
            details: { calls: [{ name: 'read', args: '{"path":"x"}', status: 'ok', durationMs: 42 }] } }, { img1: 'data:image/png;base64,aA==' });
        expect(output.querySelectorAll('.tool-result')).toHaveLength(3);
        expect(output.querySelector('b')).toBeNull();
        expect(output.querySelector('img')!.src).toBe('data:image/png;base64,aA==');
        expect(output.querySelector('.tool-duration')!.textContent).toBe('42 ms');
    });
    it('keeps image-only tool results visible and shows persisted execution time', () => {
        const card = buildToolCard({ toolName: 'read', toolCallId: 'read1', durationMs: 1250, content: [{ type: 'image', data: 'aA==', mimeType: 'image/png' }] },
            { allMessages: [], msgIndex: 0, approvalTraces: new Map() });
        expect(card.querySelector('img')).not.toBeNull();
        expect(card.querySelector('.tool-footer')!.textContent).toContain('1.3 s');
    });
});
