// DOM element helpers shared across the webview UI. Kept separate from any
// state so they can be unit-tested and reused by every renderer.

export function el(tag: string, className?: string): HTMLElement {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
}

export function escHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}
