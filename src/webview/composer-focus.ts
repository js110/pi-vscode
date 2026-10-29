/** Focus the composer on a plain panel click without disrupting other interactions. */
export function installComposerFocus(): void {
    let start: { x: number; y: number } | undefined;
    document.addEventListener('pointerdown', event => {
        start = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
    }, true);
    document.addEventListener('click', event => {
        const origin = start;
        start = undefined;
        if (event.defaultPrevented || event.button !== 0 || event.detail > 1 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4) return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest('#app')) return;
        if (target.closest('button, a, input, textarea, select, option, summary, label, [contenteditable]:not([contenteditable="false"]), [tabindex], [role="button"], [role="menuitem"], [role="option"], [role="tab"], .tab, .footer-model, .diff-card, .diff-file-header, .tool-card, .tool-clickable, .changed-file-item, .session-panel, .native-panel, .model-picker, .slash-menu, .mention-menu, .ctx-menu, .queued-section')) return;
        if (document.querySelector('#extension-dialog, #extension-custom, #session-panel, #model-picker, .ctx-menu')) return;
        const selection = document.getSelection();
        if (selection && !selection.isCollapsed && selection.toString().length > 0) return;
        const input = document.querySelector<HTMLTextAreaElement>('#input');
        if (input && !input.disabled) input.focus({ preventScroll: true });
    });
}
