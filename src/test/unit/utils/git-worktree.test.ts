import { describe, expect, it, vi } from 'vitest';
import {
    WorktreeError,
    createWorktree,
    findRepoRoot,
    listManagedWorktrees,
    removeWorktree,
    slugifyWorktreeName,
    type GitExec,
} from '../../../utils/git-worktree';

/** Scripted git: match on a joined-args prefix, return stdout or throw. */
function scripted(responses: Array<{ match: string; stdout?: string; error?: string }>): GitExec {
    const seen: string[] = [];
    const exec: GitExec = async (args) => {
        const joined = args.join(' ');
        seen.push(joined);
        for (const r of responses) {
            if (joined.startsWith(r.match)) {
                if (r.error !== undefined) {
                    const err: any = new Error(r.error);
                    err.stderr = r.error;
                    throw err;
                }
                return { stdout: r.stdout ?? '', stderr: '' };
            }
        }
        throw new Error(`unexpected git call: ${joined}`);
    };
    (exec as any).calls = seen;
    return exec;
}

const ROOT = '/repo';

describe('slugifyWorktreeName', () => {
    it('lowercases, hyphenates, and trims', () => {
        expect(slugifyWorktreeName('Fix the Login Bug!')).toBe('fix-the-login-bug');
    });
    it('keeps CJK characters', () => {
        expect(slugifyWorktreeName('修复登录')).toBe('修复登录');
    });
    it('falls back to task when empty', () => {
        expect(slugifyWorktreeName('!!!')).toBe('task');
    });
    it('caps length at 40', () => {
        expect(slugifyWorktreeName('a'.repeat(80)).length).toBe(40);
    });
});

describe('findRepoRoot', () => {
    it('returns the trimmed toplevel', async () => {
        const exec = scripted([{ match: 'rev-parse --show-toplevel', stdout: `${ROOT}\n` }]);
        await expect(findRepoRoot('/repo/src', exec)).resolves.toBe(ROOT);
    });
    it('wraps failures as not_git_repo', async () => {
        const exec = scripted([{ match: 'rev-parse --show-toplevel', error: 'not a git repository' }]);
        await expect(findRepoRoot('/tmp', exec)).rejects.toMatchObject({ code: 'not_git_repo' });
    });
});

describe('createWorktree', () => {
    it('creates a worktree under .pi/worktrees on a pi/ branch', async () => {
        const exec = scripted([
            { match: 'rev-parse --show-toplevel', stdout: ROOT },
            { match: 'rev-parse --abbrev-ref HEAD', stdout: 'main\n' },
            { match: 'rev-parse --verify --quiet refs/heads/pi/login-fix', error: 'does not exist' },
            { match: 'worktree add' },
            { match: 'rev-parse --absolute-git-dir', error: 'ENOENT' },
        ]);
        const meta = await createWorktree({ repoPath: '/repo/src', name: 'Login Fix', exec });
        expect(meta).toEqual({ path: `${ROOT}/.pi/worktrees/login-fix`, branch: 'pi/login-fix', baseBranch: 'main' });
        expect((exec as any).calls).toContainEqual(`worktree add ${ROOT}/.pi/worktrees/login-fix -b pi/login-fix --no-track`);
    });

    it('suffixes the branch when pi/<name> already exists', async () => {
        const exec = scripted([
            { match: 'rev-parse --show-toplevel', stdout: ROOT },
            { match: 'rev-parse --abbrev-ref HEAD', stdout: 'main\n' },
            { match: 'rev-parse --verify --quiet refs/heads/pi/task', stdout: 'abc123 refs/heads/pi/task\n' },
            { match: 'worktree add' },
            { match: 'rev-parse --absolute-git-dir', error: 'ENOENT' },
        ]);
        const meta = await createWorktree({ repoPath: ROOT, name: 'task', exec });
        expect(meta.branch).toMatch(/^pi\/task-[0-9a-f]{8}$/);
        expect(meta.path).toBe(`${ROOT}/.pi/worktrees/${meta.branch.slice(3)}`);
    });

    it('passes an explicit base branch to worktree add', async () => {
        const exec = scripted([
            { match: 'rev-parse --show-toplevel', stdout: ROOT },
            { match: 'rev-parse --verify --quiet refs/heads/pi/x', error: 'nope' },
            { match: 'worktree add' },
            { match: 'rev-parse --absolute-git-dir', error: 'ENOENT' },
        ]);
        await createWorktree({ repoPath: ROOT, name: 'x', baseBranch: 'develop', exec });
        expect((exec as any).calls).toContainEqual(
            `worktree add ${ROOT}/.pi/worktrees/x -b pi/x --no-track develop`,
        );
    });

    it('surfaces git failures as git_failed', async () => {
        const exec = scripted([
            { match: 'rev-parse --show-toplevel', stdout: ROOT },
            { match: 'rev-parse --abbrev-ref HEAD', stdout: 'main\n' },
            { match: 'rev-parse --verify --quiet refs/heads/pi/y', error: 'nope' },
            { match: 'worktree add', error: 'fatal: invalid ref' },
        ]);
        await expect(createWorktree({ repoPath: ROOT, name: 'y', exec })).rejects.toMatchObject({
            code: 'git_failed',
            message: 'fatal: invalid ref',
        });
    });
});

describe('removeWorktree', () => {
    it('refuses dirty worktrees with code dirty', async () => {
        const exec = scripted([
            { match: 'rev-parse --show-toplevel', stdout: ROOT },
            { match: 'status --porcelain', stdout: ' M src/a.ts\n' },
        ]);
        await expect(
            removeWorktree({ repoPath: ROOT, worktreePath: `${ROOT}/.pi/worktrees/x`, exec }),
        ).rejects.toMatchObject({ code: 'dirty' });
    });

    it('removes the worktree and optionally the branch', async () => {
        const exec = scripted([
            { match: 'rev-parse --show-toplevel', stdout: ROOT },
            { match: 'status --porcelain', stdout: '' },
            { match: 'worktree remove' },
            { match: 'branch -D' },
        ]);
        await removeWorktree({
            repoPath: ROOT,
            worktreePath: `${ROOT}/.pi/worktrees/x`,
            deleteBranch: 'pi/x',
            exec,
        });
        expect((exec as any).calls).toContainEqual(`worktree remove ${ROOT}/.pi/worktrees/x`);
        expect((exec as any).calls).toContainEqual('branch -D pi/x');
    });
});

describe('listManagedWorktrees', () => {
    it('parses porcelain output and filters to managed paths', async () => {
        const porcelain = [
            'worktree /repo',
            'HEAD abc111',
            'branch refs/heads/main',
            '',
            `worktree ${ROOT}/.pi/worktrees/login-fix`,
            'HEAD abc222',
            'branch refs/heads/pi/login-fix',
            '',
            'worktree /other/random',
            'HEAD abc333',
            'branch refs/heads/other',
            '',
        ].join('\n');
        const exec = scripted([
            { match: 'rev-parse --show-toplevel', stdout: ROOT },
            { match: 'worktree list --porcelain', stdout: porcelain },
            { match: 'status --porcelain', stdout: '' },
        ]);
        const list = await listManagedWorktrees(ROOT, exec);
        expect(list).toEqual([
            { path: `${ROOT}/.pi/worktrees/login-fix`, branch: 'pi/login-fix', baseBranch: '', dirty: false },
        ]);
    });
});

describe('WorktreeError', () => {
    it('carries a machine-readable code', () => {
        const err = new WorktreeError('dirty', '/x');
        expect(err instanceof WorktreeError).toBe(true);
        expect(err.code).toBe('dirty');
    });
});
