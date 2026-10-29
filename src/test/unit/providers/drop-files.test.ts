import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
    const files: Record<string, string> = {
        '/workspace/folder/a.txt': 'one', '/workspace/folder/sub/b.txt': 'two',
        '/outside/dir/note.txt': 'external', '/outside/dir/binary.dat': '\0binary',
    };
    const dirs: Record<string, string[]> = { '/workspace/folder': ['a.txt', 'sub'], '/workspace/folder/sub': ['b.txt'], '/outside/dir': ['note.txt', 'binary.dat'] };
    return {
        FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
        Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' } }], fs: {
            stat: async ({ fsPath }: { fsPath: string }) => {
                if (dirs[fsPath]) return { type: 2, size: 0 };
                if (files[fsPath] !== undefined) return { type: 1, size: files[fsPath].length };
                throw new Error('missing');
            },
            readDirectory: async ({ fsPath }: { fsPath: string }) => dirs[fsPath].map(name => [name, 1]),
            readFile: async () => { throw new Error('must not read contents'); },
        } },
    };
});
import { resolveDroppedFiles } from '../../../providers/drop-files';

describe('host drag resolution', () => {
    it('returns the absolute directory path without reading its contents', async () => {
        expect(await resolveDroppedFiles(['file:///workspace/folder'])).toEqual([
            { status: 'path', path: '/workspace/folder' },
        ]);
    });
    it('returns paths for external text and binary files without reading them', async () => {
        expect(await resolveDroppedFiles(['file:///outside/dir/note.txt', 'file:///outside/dir/binary.dat'])).toEqual([
            { status: 'path', path: '/outside/dir/note.txt' }, { status: 'path', path: '/outside/dir/binary.dat' },
        ]);
    });
});
