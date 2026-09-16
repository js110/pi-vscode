import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SelectionContextTracker } from '../../../providers/selection-context';
import type { ServerMessage } from '../../../shared/protocol';

const h = vi.hoisted(() => ({
    activeEditor: undefined as any,
    selectionCbs: [] as ((e: any) => void)[],
    activeEditorCbs: [] as ((e: any) => void)[],
    docChangeCbs: [] as ((e: any) => void)[],
}));

vi.mock('vscode', () => ({
    window: {
        get activeTextEditor() { return h.activeEditor; },
        onDidChangeTextEditorSelection: (cb: any) => {
            h.selectionCbs.push(cb);
            return { dispose: () => {} };
        },
        onDidChangeActiveTextEditor: (cb: any) => {
            h.activeEditorCbs.push(cb);
            return { dispose: () => {} };
        },
    },
    workspace: {
        onDidChangeTextDocument: (cb: any) => {
            h.docChangeCbs.push(cb);
            return { dispose: () => {} };
        },
        asRelativePath: (uri: any) =>
            uri.fsPath.startsWith('/work/')
                ? uri.fsPath.slice('/work/'.length)
                : uri.fsPath,
    },
}));

function makeEditor(code: string, opts: { startLine?: number; endLine?: number; endChar?: number; path?: string; isEmpty?: boolean } = {}): any {
    const lines = code.split('\n');
    const startLine = opts.startLine ?? 0;
    const endLine = opts.endLine ?? startLine;
    const endChar = opts.endChar ?? (lines[endLine]?.length ?? 0);
    return {
        document: {
            uri: { fsPath: opts.path ?? '/work/src/a.ts' },
            languageId: 'ts',
            getText: (sel: any) => {
                if (!sel) return code;
                const picked = lines.slice(sel.start.line, sel.end.line + 1);
                if (sel.end.character === 0 && sel.end.line > sel.start.line) picked.pop();
                else if (sel.end.line === sel.start.line) {
                    picked[0] = picked[0]?.slice(sel.start.character, sel.end.character) ?? '';
                } else {
                    picked[0] = picked[0]?.slice(sel.start.character) ?? '';
                }
                return picked.join('\n');
            },
        },
        selection: {
            isEmpty: opts.isEmpty ?? false,
            start: { line: startLine, character: 0 },
            end: { line: endLine, character: endChar },
        },
    };
}

const flush = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeTracker(debounceMs = 1) {
    const posted: ServerMessage[] = [];
    const notify = vi.fn();
    const tracker = new SelectionContextTracker(
        (msg) => posted.push(msg),
        notify,
        debounceMs,
    );
    return { tracker, posted, notify };
}

describe('SelectionContextTracker', () => {
    beforeEach(() => {
        h.activeEditor = undefined;
        h.selectionCbs = [];
        h.activeEditorCbs = [];
        h.docChangeCbs = [];
    });

    it('broadcasts the selection as display info when one becomes active', async () => {
        const { tracker, posted } = makeTracker();
        h.activeEditor = makeEditor('line0\nline1\nline2\n', { startLine: 1, endLine: 2, endChar: 3 });

        h.selectionCbs.forEach((cb) => cb({}));
        await flush();

        expect(posted).toEqual([{
            type: 'selectionChanged',
            selection: { path: 'src/a.ts', startLine: 2, endLine: 3 },
        }]);
        expect(tracker.current).toEqual({ path: 'src/a.ts', startLine: 2, endLine: 3 });
    });

    it('keeps the chip when focus moves to the panel (no active editor)', async () => {
        const { tracker, posted } = makeTracker();
        h.activeEditor = makeEditor('a\nb\n', { startLine: 0, endLine: 0, endChar: 1 });
        h.selectionCbs.forEach((cb) => cb({}));
        await flush();
        expect(posted).toHaveLength(1);

        // Clicking into the webview input clears activeTextEditor.
        h.activeEditor = undefined;
        h.activeEditorCbs.forEach((cb) => cb(undefined));
        h.selectionCbs.forEach((cb) => cb({}));
        await flush();

        expect(tracker.current).toEqual({ path: 'src/a.ts', startLine: 1, endLine: 1 });
        expect(posted).toHaveLength(1);
    });

    it('still wraps after focus moved to the panel, using the snapshot', async () => {
        const { tracker } = makeTracker();
        h.activeEditor = makeEditor('const a = 1;\n', { startLine: 0, endLine: 0, endChar: 12 });
        h.selectionCbs.forEach((cb) => cb({}));
        await flush();

        h.activeEditor = undefined;
        h.activeEditorCbs.forEach((cb) => cb(undefined));
        await flush();

        const wrapped = tracker.consumePrompt('explain this');
        expect(wrapped).toContain('src/a.ts:1');
        expect(wrapped).toContain('const a = 1;');
        expect(wrapped!.endsWith('explain this')).toBe(true);
        expect(tracker.current).toBeNull();
    });

    it('clears when another editor becomes active without a selection', async () => {
        const { tracker, posted } = makeTracker();
        h.activeEditor = makeEditor('a\n', { startLine: 0, endLine: 0, endChar: 1 });
        h.selectionCbs.forEach((cb) => cb({}));
        await flush();

        h.activeEditor = makeEditor('other\n', { path: '/work/b.ts', isEmpty: true });
        h.activeEditorCbs.forEach((cb) => cb(h.activeEditor));
        await flush();

        expect(tracker.current).toBeNull();
        expect(posted.at(-1)).toEqual({ type: 'selectionChanged', selection: null });
    });

    it('stays silent while there is no selection', async () => {
        makeTracker();
        h.activeEditor = makeEditor('x\n', { isEmpty: true });

        h.selectionCbs.forEach((cb) => cb({}));
        await flush();
        // No chip ever existed — nothing to broadcast.
    });

    it('posts null once when the selection collapses', async () => {
        const { tracker, posted } = makeTracker();
        h.activeEditor = makeEditor('a\nb\n', { startLine: 0, endLine: 0, endChar: 1 });
        h.selectionCbs.forEach((cb) => cb({}));
        await flush();
        expect(posted).toHaveLength(1);

        h.activeEditor.selection.isEmpty = true;
        h.selectionCbs.forEach((cb) => cb({}));
        await flush();

        expect(posted).toHaveLength(2);
        expect(posted[1]).toEqual({ type: 'selectionChanged', selection: null });
        expect(tracker.current).toBeNull();
    });

    it('does not repost when the selection is unchanged', async () => {
        const { posted } = makeTracker();
        h.activeEditor = makeEditor('a\nb\n', { startLine: 0, endLine: 0, endChar: 1 });

        h.selectionCbs.forEach((cb) => cb({}));
        await flush();
        h.selectionCbs.forEach((cb) => cb({}));
        await flush();

        expect(posted).toHaveLength(1);
    });

    it('wraps the next prompt and clears the chip', async () => {
        const { tracker, posted } = makeTracker();
        h.activeEditor = makeEditor('const a = 1;\nconst b = 2;\n', { startLine: 0, endLine: 1, endChar: 11 });
        h.selectionCbs.forEach((cb) => cb({}));
        await flush();

        const wrapped = tracker.consumePrompt('explain this');

        expect(wrapped).toContain('src/a.ts:1-2');
        expect(wrapped).toContain('const a = 1;');
        expect(wrapped!.endsWith('explain this')).toBe(true);
        expect(tracker.current).toBeNull();
        expect(posted.at(-1)).toEqual({ type: 'selectionChanged', selection: null });
    });

    it('returns the plain text when no chip is showing', async () => {
        const { tracker } = makeTracker();
        h.activeEditor = undefined;

        expect(tracker.consumePrompt('hello')).toBeNull();
    });

    it('drops an oversized selection with a notice but keeps the message', async () => {
        const { tracker, notify } = makeTracker();
        const big = 'x'.repeat(40_001);
        h.activeEditor = makeEditor(big, { startLine: 0, endLine: 0, endChar: big.length });
        h.selectionCbs.forEach((cb) => cb({}));
        await flush();

        expect(tracker.consumePrompt('hello')).toBeNull();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(tracker.current).toBeNull();
    });

    it('reinstates the chip after a failed send', async () => {
        const { tracker, posted } = makeTracker();
        h.activeEditor = makeEditor('const a = 1;\n', { startLine: 0, endLine: 0, endChar: 12 });
        h.selectionCbs.forEach((cb) => cb({}));
        await flush();
        const prior = tracker.current;

        expect(tracker.consumePrompt('go')).not.toBeNull();
        expect(tracker.current).toBeNull();

        tracker.reinstate(prior);

        expect(tracker.current).toEqual(prior);
        expect(posted.at(-1)).toEqual({ type: 'selectionChanged', selection: prior });
        // The reinstated snapshot still wraps.
        expect(tracker.consumePrompt('again')).toContain('const a = 1;');
    });

    it('dismiss clears the chip and notifies the webview', async () => {
        const { tracker, posted } = makeTracker();
        h.activeEditor = makeEditor('a\n', { startLine: 0, endLine: 0, endChar: 1 });
        h.selectionCbs.forEach((cb) => cb({}));
        await flush();

        tracker.dismiss();

        expect(tracker.current).toBeNull();
        expect(posted.at(-1)).toEqual({ type: 'selectionChanged', selection: null });
    });

    it('stops reacting after dispose (pending debounce dropped)', async () => {
        const { tracker, posted } = makeTracker();
        h.activeEditor = makeEditor('a\n', { startLine: 0, endLine: 0, endChar: 1 });

        h.selectionCbs.forEach((cb) => cb({}));
        tracker.dispose();
        await flush();

        expect(tracker.current).toBeNull();
        expect(posted).toHaveLength(0);
    });

    it('refreshes the range when the document changes', async () => {
        const { posted } = makeTracker();
        const editor = makeEditor('a\nb\nc\n', { startLine: 0, endLine: 1, endChar: 1 });
        h.activeEditor = editor;
        h.selectionCbs.forEach((cb) => cb({}));
        await flush();
        expect(posted).toHaveLength(1);

        h.docChangeCbs.forEach((cb) => cb({ document: editor.document }));
        await flush();

        // Same selection bounds → no new broadcast, just a re-read.
        expect(posted).toHaveLength(1);
    });
});
