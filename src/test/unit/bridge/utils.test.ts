import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [] as any[],
  },
}));

const V = vscode as any;

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-guard-ws-')));
  outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-guard-out-')));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export {};');
  V.workspace.workspaceFolders = [{ name: 'ws', uri: { fsPath: root } }];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

async function guard() {
  return (await import('../../../bridge/utils')).assertWritePathInWorkspace;
}

describe('bridge write-path guard', () => {
  it('accepts a path inside the workspace', async () => {
    const assertWritePathInWorkspace = await guard();
    expect(assertWritePathInWorkspace(path.join(root, 'src', 'a.ts'))).toBe(path.join(root, 'src', 'a.ts'));
  });

  it('accepts a not-yet-existing file inside the workspace', async () => {
    const assertWritePathInWorkspace = await guard();
    expect(() => assertWritePathInWorkspace(path.join(root, 'src', 'new.ts'))).not.toThrow();
  });

  it('rejects a .. traversal that resolves outside the workspace', async () => {
    const assertWritePathInWorkspace = await guard();
    const escaped = path.join(root, '..', path.basename(outside), 'secret.txt');
    expect(fs.realpathSync.native(escaped)).toBe(path.join(outside, 'secret.txt'));
    expect(() => assertWritePathInWorkspace(escaped)).toThrow(/outside the workspace/);
  });

  it('rejects a symlink inside the workspace that points outside it', async () => {
    const assertWritePathInWorkspace = await guard();
    const link = path.join(root, 'src', 'link.txt');
    fs.symlinkSync(path.join(outside, 'secret.txt'), link);
    expect(() => assertWritePathInWorkspace(link)).toThrow(/outside the workspace/);
  });

  it('does not treat a sibling directory with the same prefix as inside', async () => {
    const assertWritePathInWorkspace = await guard();
    const sibling = `${root}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    try {
      expect(() => assertWritePathInWorkspace(path.join(sibling, 'x.ts'))).toThrow(/outside the workspace/);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('refuses every write when no workspace is open', async () => {
    V.workspace.workspaceFolders = [];
    const assertWritePathInWorkspace = await guard();
    expect(() => assertWritePathInWorkspace(path.join(root, 'src', 'a.ts'))).toThrow(/No workspace is open/);
  });
});
