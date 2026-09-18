// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { showToast } from '../../../webview/toast';

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('showToast', () => {
    it('mounts a toast and removes it after the duration', () => {
        vi.useFakeTimers();
        showToast({ className: 'notice-toast', message: 'hello', durationMs: 4000 });

        const toast = document.querySelector('.notice-toast') as HTMLElement;
        expect(toast).toBeTruthy();
        expect(toast.textContent).toBe('hello');

        vi.advanceTimersByTime(3999);
        expect(document.querySelector('.notice-toast')).toBeTruthy();
        vi.advanceTimersByTime(1);
        expect(document.querySelector('.notice-toast')).toBeNull();
    });

    it('mounts into a container when one is given', () => {
        vi.useFakeTimers();
        const container = document.createElement('div');
        container.id = 'messages';
        document.body.appendChild(container);

        showToast({ containerId: 'messages', className: 'notice-toast', message: 'x' });
        expect(container.querySelector('.notice-toast')).toBeTruthy();
    });

    it('does nothing when the container is missing', () => {
        vi.useFakeTimers();
        showToast({ containerId: 'nope', className: 'notice-toast', message: 'x' });
        expect(document.querySelector('.notice-toast')).toBeNull();
    });

    it('reuses one element by id and hides it via the remaining class', () => {
        vi.useFakeTimers();
        showToast({ reuseId: 'toast', className: 'toast toast-info', hideClass: 'visible', message: 'a', durationMs: 3000 });
        showToast({ reuseId: 'toast', className: 'toast toast-error', hideClass: 'visible', message: 'b', durationMs: 3000 });

        const toasts = document.querySelectorAll('#toast');
        expect(toasts).toHaveLength(1);
        const toast = toasts[0] as HTMLElement;
        expect(toast.textContent).toBe('b');
        expect(toast.classList.contains('toast-error')).toBe(true);
        expect(toast.classList.contains('visible')).toBe(true);

        vi.advanceTimersByTime(3000);
        expect(document.getElementById('toast')).toBeTruthy();
        expect(toast.classList.contains('visible')).toBe(false);
    });
});
