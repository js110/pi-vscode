// Transient toast helper shared by the chat and settings webview bundles.
// Mounts (or reuses) an element, sets its text, and auto-dismisses it. When
// `hideClass` is given the element is kept mounted and the class is removed —
// the settings toast's CSS contract — otherwise the node is removed, which is
// what the chat notices do.

import { el } from './dom';

export interface ToastOptions {
    className: string;
    message: string;
    /** Reuse a single element with this id instead of stacking new ones. */
    reuseId?: string;
    /** Id of the mount container; defaults to document.body. */
    containerId?: string;
    durationMs?: number;
    /** Dismiss by removing this class instead of the node. */
    hideClass?: string;
}

const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export function showToast(options: ToastOptions): void {
    const { className, message, reuseId, containerId, durationMs = 4000, hideClass } = options;
    const container = containerId ? document.getElementById(containerId) : document.body;
    if (!container) return;

    const existing = reuseId ? document.getElementById(reuseId) : null;
    const toast = existing ?? el('div', className);
    if (!existing) {
        if (reuseId) toast.id = reuseId;
        container.appendChild(toast);
    }

    toast.className = hideClass ? `${className} ${hideClass}` : className;
    toast.textContent = message;

    const previous = timers.get(toast);
    if (previous) clearTimeout(previous);
    timers.set(
        toast,
        setTimeout(() => {
            timers.delete(toast);
            if (hideClass) toast.classList.remove(hideClass);
            else toast.remove();
        }, durationMs),
    );
}
