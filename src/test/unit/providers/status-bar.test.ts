import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusBarManager } from '../../../providers/status-bar';
import { setLang } from '../../../shared/i18n';

const h = vi.hoisted(() => ({
    items: [] as {
        text: string;
        tooltip: string;
        command: string | undefined;
        showCount: number;
        disposed: boolean;
        show(): void;
        dispose(): void;
    }[],
    makeItem: null as unknown as () => {
        text: string;
        tooltip: string;
        command: string | undefined;
        showCount: number;
        disposed: boolean;
        show(): void;
        dispose(): void;
    },
}));

h.makeItem = () => ({
    text: '',
    tooltip: '',
    command: undefined,
    showCount: 0,
    disposed: false,
    show() { this.showCount += 1; },
    dispose() { this.disposed = true; },
});

vi.mock('vscode', () => ({
    StatusBarAlignment: { Left: 0, Right: 1 },
    window: {
        createStatusBarItem: () => {
            const item = h.makeItem();
            h.items.push(item);
            return item;
        },
    },
}));

function makeTabManager(activeTab: unknown = undefined): any {
    return {
        activeTab,
        isStreaming: false,
        onStateChange: () => () => {},
    };
}

function makeManager(activeTab?: unknown) {
    const mgr = new StatusBarManager(makeTabManager(activeTab));
    const open = h.items.find((i) => i.command === 'pi-agent.focusChat');
    const model = h.items.find((i) => i.command === 'pi-agent.selectModel');
    if (!open || !model) throw new Error('expected both status bar items to exist');
    return { mgr, open, model };
}

describe('StatusBarManager open-panel entry', () => {
    beforeEach(() => {
        h.items.length = 0;
        setLang('en');
    });

    it('shows a persistent open-panel entry next to the model entry', () => {
        const { open, model } = makeManager();
        expect(open.text).toBe('$(comment-discussion)');
        expect(open.tooltip).toBe('Open Pi Agent panel');
        expect(open.showCount).toBe(1);
        expect(model.command).toBe('pi-agent.selectModel');
    });

    it('stays visible before any tab/session is initialized', () => {
        const { open, model } = makeManager(undefined);
        expect(open.showCount).toBe(1);
        // The model entry has nothing to show until a session exists.
        expect(model.text).toBe('');
    });

    it('follows the display language after refresh()', () => {
        const { mgr, open } = makeManager();
        expect(open.tooltip).toBe('Open Pi Agent panel');
        setLang('zh');
        mgr.refresh();
        expect(open.tooltip).toBe('打开 Pi Agent 面板');
    });

    it('disposes both status bar items on dispose', () => {
        const { mgr, open, model } = makeManager();
        mgr.dispose();
        expect(open.disposed).toBe(true);
        expect(model.disposed).toBe(true);
    });
});
