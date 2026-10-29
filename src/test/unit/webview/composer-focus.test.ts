// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installComposerFocus } from '../../../webview/composer-focus';

beforeAll(() => installComposerFocus());
beforeEach(() => {
    document.body.innerHTML = `<div id="app"><div id="messages"><p id="text">selectable text</p><button id="action">Action</button><a id="link" href="#x">Link</a><div class="diff-file-header" id="diff">Diff</div></div><textarea id="input"></textarea></div>`;
    document.getSelection()?.removeAllRanges();
});
function click(target: Element, extra: MouseEventInit = {}) {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ...extra }));
}

describe('panel click focuses the composer', () => {
    it('focuses after clicking ordinary transcript content', () => {
        click(document.getElementById('text')!);
        expect(document.activeElement?.id).toBe('input');
    });
    it('leaves interactive controls and modified clicks alone', () => {
        for (const id of ['action', 'link', 'diff']) {
            (document.activeElement as HTMLElement)?.blur();
            click(document.getElementById(id)!);
            expect(document.activeElement?.id).not.toBe('input');
        }
        click(document.getElementById('text')!, { metaKey: true });
        expect(document.activeElement?.id).not.toBe('input');
    });
    it('preserves selected transcript text', () => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('text')!);
        document.getSelection()!.addRange(range);
        click(document.getElementById('text')!);
        expect(document.activeElement?.id).not.toBe('input');
        expect(document.getSelection()!.toString()).toBe('selectable text');
    });
    it('does not focus after a drag or while an interactive panel is open', () => {
        const text = document.getElementById('text')!;
        text.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
        click(text, { clientX: 20, clientY: 20 });
        expect(document.activeElement?.id).not.toBe('input');
        const panel = document.createElement('div'); panel.id = 'extension-dialog'; document.getElementById('app')!.append(panel);
        click(text);
        expect(document.activeElement?.id).not.toBe('input');
    });
    it('respects a disabled composer', () => {
        (document.getElementById('input') as HTMLTextAreaElement).disabled = true;
        click(document.getElementById('text')!);
        expect(document.activeElement?.id).not.toBe('input');
    });
});
