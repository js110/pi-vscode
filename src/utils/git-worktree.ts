/**
 * Git worktree helpers for parallel agent tabs (design borrowed from the
 * Copilot CLI worktree isolation and Kilo Code's agent-manager worktrees).
 *
 * Everything here is a pure function over an injected `exec`, so the module
 * stays unit-testable without touching the filesystem or `child_process`.
 * The Node binding lives at the bottom (`createNodeGitExec`).
 */

export interface GitExecResult {
    stdout: string;
    stderr: string;
}

export type GitExec = (args: string[], opts?: { cwd?: string }) => Promise<GitExecResult>;

export interface WorktreeMeta {
    /** Absolute path of the worktree checkout. */
    path: string;
    /** Branch checked out in the worktree (`pi/<slug>`). */
    branch: string;
    /** Branch the worktree was created from. */
    baseBranch: string;
}

export type WorktreeErrorCode =
    | 'not_git_repo'
    | 'dir_exists'
    | 'dirty'
    | 'git_failed';

export class WorktreeError extends Error {
    constructor(
        public readonly code: WorktreeErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'WorktreeError';
    }
}

/** Directory (relative to the repo root) where managed worktrees live. */
export const WORKTREE_DIR = '.pi/worktrees';
/** Branch prefix for managed worktrees (Copilot uses `copilot/`, Kilo `kilo-`). */
export const WORKTREE_BRANCH_PREFIX = 'pi/';
/** Line appended to `.git/info/exclude` so managed worktrees stay untracked. */
export const WORKTREE_EXCLUDE_LINE = `/${WORKTREE_DIR}/`;

/** Turn a free-form name into a filesystem/branch-safe slug. */
export function slugifyWorktreeName(name: string): string {
    const slug = name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '');
    return slug || 'task';
}

function randomSuffix(): string {
    return Math.random().toString(16).slice(2, 10);
}

/** `git rev-parse --show-toplevel` — resolves the repo root for a path. */
export async function findRepoRoot(cwd: string, exec: GitExec): Promise<string> {
    try {
        const { stdout } = await exec(['rev-parse', '--show-toplevel'], { cwd });
        const root = stdout.trim();
        if (!root) throw new Error('empty toplevel');
        return root;
    } catch (err: any) {
        throw new WorktreeError('not_git_repo', err?.stderr?.trim() || err?.message || String(err));
    }
}

async function gitDir(repoRoot: string, exec: GitExec): Promise<string> {
    const { stdout } = await exec(['rev-parse', '--absolute-git-dir'], { cwd: repoRoot });
    return stdout.trim();
}

async function branchExists(repoRoot: string, branch: string, exec: GitExec): Promise<boolean> {
    try {
        await exec(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot });
        return true;
    } catch {
        return false;
    }
}

async function currentBranch(repoRoot: string, exec: GitExec): Promise<string> {
    const { stdout } = await exec(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
    return stdout.trim() || 'HEAD';
}

/** Keep the managed worktree dir out of `git status` without touching .gitignore. */
async function ensureExcluded(repoRoot: string, exec: GitExec): Promise<void> {
    // Exclusion is cosmetic (worktrees stay untracked visually): every step
    // here is best-effort and must never fail worktree creation — including
    // git-dir resolution on unusual checkouts (bare / linked / missing).
    try {
        const dir = await gitDir(repoRoot, exec);
        const excludePath = `${dir}/info/exclude`;
        const fs = await import('fs');
        let existing = '';
        try {
            existing = await fs.promises.readFile(excludePath, 'utf8');
        } catch {
            existing = '';
        }
        if (existing.split('\n').some((line) => line.trim() === WORKTREE_EXCLUDE_LINE)) return;
        await fs.promises.mkdir(`${dir}/info`, { recursive: true });
        const appended = existing.endsWith('\n') || existing === ''
            ? `${existing}${WORKTREE_EXCLUDE_LINE}\n`
            : `${existing}\n${WORKTREE_EXCLUDE_LINE}\n`;
        await fs.promises.writeFile(excludePath, appended, 'utf8');
    } catch {
        // best effort only — see above
    }
}

export interface CreateWorktreeOptions {
    /** Any path inside the repository (usually the workspace folder). */
    repoPath: string;
    /** Free-form task name; slugged into the branch and directory name. */
    name: string;
    /** Explicit base branch; defaults to the current HEAD branch. */
    baseBranch?: string;
    exec: GitExec;
}

/**
 * Create a managed worktree at `<repoRoot>/${WORKTREE_DIR}/<slug>` on a new
 * branch `pi/<slug>`, de-conflicted with a random suffix when either the
 * branch or the directory already exists (Copilot's approach).
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeMeta> {
    const { exec } = opts;
    const repoRoot = await findRepoRoot(opts.repoPath, exec);

    const base = opts.baseBranch ?? (await currentBranch(repoRoot, exec));
    const slugBase = slugifyWorktreeName(opts.name);

    let slug = slugBase;
    let branch = `${WORKTREE_BRANCH_PREFIX}${slug}`;
    if (await branchExists(repoRoot, branch, exec)) {
        slug = `${slugBase}-${randomSuffix()}`;
        branch = `${WORKTREE_BRANCH_PREFIX}${slug}`;
    }

    const worktreePath = `${repoRoot}/${WORKTREE_DIR}/${slug}`;
    // Guard the directory before spawning git: `worktree add` on an existing
    // dir fails with a confusing message.
    const fs = await import('fs');
    try {
        await fs.promises.access(worktreePath);
        throw new WorktreeError('dir_exists', worktreePath);
    } catch (err: any) {
        if (err instanceof WorktreeError) throw err;
        // ENOENT — the path is free, continue.
    }

    const args = ['worktree', 'add', worktreePath, '-b', branch, '--no-track'];
    if (opts.baseBranch) args.push(opts.baseBranch);
    try {
        await exec(args, { cwd: repoRoot });
    } catch (err: any) {
        throw new WorktreeError('git_failed', err?.stderr?.trim() || err?.message || String(err));
    }

    await ensureExcluded(repoRoot, exec);
    return { path: worktreePath, branch, baseBranch: base };
}

/** Non-empty `git status --porcelain` output means uncommitted changes. */
export async function hasUncommittedChanges(worktreePath: string, exec: GitExec): Promise<boolean> {
    try {
        const { stdout } = await exec(['status', '--porcelain'], { cwd: worktreePath });
        return stdout.trim().length > 0;
    } catch {
        // A missing worktree counts as clean so `git worktree remove --force`
        // can prune it in cleanup.
        return false;
    }
}

export interface RemoveWorktreeOptions {
    repoPath: string;
    worktreePath: string;
    /** Also delete the branch (only reached when the worktree is clean). */
    deleteBranch?: string;
    exec: GitExec;
}

/** Remove a managed worktree. Refuses (`code: 'dirty'`) when it has changes. */
export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
    const { exec } = opts;
    const repoRoot = await findRepoRoot(opts.repoPath, exec);

    if (await hasUncommittedChanges(opts.worktreePath, exec)) {
        throw new WorktreeError('dirty', opts.worktreePath);
    }

    try {
        await exec(['worktree', 'remove', opts.worktreePath], { cwd: repoRoot });
    } catch (err: any) {
        // Prune a half-deleted worktree, then report the original failure.
        try {
            await exec(['worktree', 'prune'], { cwd: repoRoot });
        } catch { /* best effort */ }
        throw new WorktreeError('git_failed', err?.stderr?.trim() || err?.message || String(err));
    }

    if (opts.deleteBranch) {
        try {
            await exec(['branch', '-D', opts.deleteBranch], { cwd: repoRoot });
        } catch (err: any) {
            throw new WorktreeError('git_failed', err?.stderr?.trim() || err?.message || String(err));
        }
    }
}

export interface ManagedWorktree extends WorktreeMeta {
    dirty: boolean;
}

/** List worktrees created by us (under `WORKTREE_DIR`), with dirty state. */
export async function listManagedWorktrees(repoPath: string, exec: GitExec): Promise<ManagedWorktree[]> {
    const repoRoot = await findRepoRoot(repoPath, exec);
    const { stdout } = await exec(['worktree', 'list', '--porcelain'], { cwd: repoRoot });

    const prefix = `${repoRoot}/${WORKTREE_DIR}/`;
    const entries: { path: string; branch: string; head: string }[] = [];
    let current: { path: string; branch: string; head: string } | null = null;
    for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
            if (current) entries.push(current);
            current = { path: line.slice('worktree '.length), branch: '', head: '' };
        } else if (line.startsWith('branch ') && current) {
            current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        } else if (line.startsWith('HEAD ') && current) {
            current.head = line.slice('HEAD '.length);
        }
    }
    if (current) entries.push(current);

    const managed: ManagedWorktree[] = [];
    for (const entry of entries) {
        if (!entry.path.startsWith(prefix)) continue;
        managed.push({
            path: entry.path,
            branch: entry.branch,
            baseBranch: '',
            dirty: await hasUncommittedChanges(entry.path, exec),
        });
    }
    return managed;
}

// ── Node binding (extension host only) ─────────────────────────────────────

/** Production `exec` backed by `child_process.execFile('git', ...)`. */
export function createNodeGitExec(): GitExec {
    // Imported lazily so the pure core above stays loadable in tests that
    // never touch Node builtins.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFile } = require('child_process') as typeof import('child_process');
    return (args: string[], opts?: { cwd?: string }) =>
        new Promise<GitExecResult>((resolve, reject) => {
            execFile(
                'git',
                args,
                { cwd: opts?.cwd, maxBuffer: 10 * 1024 * 1024, timeout: 30_000 },
                (err: any, stdout: string, stderr: string) => {
                    if (err) {
                        err.stderr = stderr ?? '';
                        reject(err);
                    } else {
                        resolve({ stdout: String(stdout), stderr: String(stderr) });
                    }
                },
            );
        });
}
