import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { expandHome, resolveWorkspacePath } from '../../../utils/paths';

const workspace = vscode.workspace as any;
const restore = () => {
    workspace.workspaceFolders = [{ uri: { fsPath: process.cwd() } }];
};

afterEach(restore);

describe('expandHome', () => {
    const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    afterEach(() => {
        process.env.HOME = original.HOME;
        process.env.USERPROFILE = original.USERPROFILE;
    });

    it('expands ~/ against the home directory', () => {
        process.env.HOME = '/home/u';
        process.env.USERPROFILE = '/home/u';
        expect(expandHome('~/a.ts')).toBe(path.join('/home/u', 'a.ts'));
    });

    it('expands a bare ~ to the home directory', () => {
        process.env.HOME = '/home/u';
        process.env.USERPROFILE = '/home/u';
        expect(expandHome('~')).toBe(path.join('/home/u', ''));
    });

    it('leaves other paths untouched', () => {
        expect(expandHome('src/a.ts')).toBe('src/a.ts');
        expect(expandHome('/abs/a.ts')).toBe('/abs/a.ts');
    });
});

describe('resolveWorkspacePath', () => {
    it('anchors relative paths to the first workspace folder', () => {
        workspace.workspaceFolders = [{ uri: { fsPath: '/work' } }];
        expect(resolveWorkspacePath('src/a.ts')).toBe(path.join('/work', 'src/a.ts'));
    });

    it('keeps absolute paths as-is', () => {
        const abs = path.resolve('absfile.ts');
        expect(resolveWorkspacePath(abs)).toBe(abs);
    });

    it('falls back to the process cwd when the window has no folder', () => {
        workspace.workspaceFolders = undefined;
        expect(resolveWorkspacePath('rel.ts')).toBe(path.resolve('rel.ts'));
    });

    it('only expands ~ when requested', () => {
        workspace.workspaceFolders = [{ uri: { fsPath: '/work' } }];
        expect(resolveWorkspacePath('~/a.ts')).toBe(path.join('/work', '~/a.ts'));
    });
});
