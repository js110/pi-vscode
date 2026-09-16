import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import {
    SessionLockManager,
    lockFileName,
    parseLockContent,
    isLockStale,
    LOCK_STALE_MS,
    type SessionLockDeps,
    type LockFileContent,
} from '../../../pi/session-lock';

const now = { value: 10_000 };

beforeEach(() => {
    now.value = 10_000;
});

/** In-memory fs double keyed by absolute lock path. */
function makeDeps(overrides: Partial<SessionLockDeps> = {}): SessionLockDeps & {
    files: Map<string, string>;
    alivePids: Set<number>;
    written: Array<{ path: string; content: string; exclusive: boolean }>;
} {
    const files = new Map<string, string>();
    const alivePids = new Set<number>([process.pid, 1000, 2000, 3000]);
    const written: Array<{ path: string; content: string; exclusive: boolean }> = [];
    let tokenSeq = 0;
    const deps: any = {
        files,
        alivePids,
        written,
        lockDir: '/locks',
        isProcessAlive(pid: number) { return alivePids.has(pid); },
        now() { return now.value; },
        hash(s: string) {
            let h = 0;
            for (const ch of s) { h = (h * 31 + ch.charCodeAt(0)) | 0; }
            return `h${Math.abs(h)}`;
        },
        newToken() { return `token-${++tokenSeq}`; },
        readFile(p: string) { return files.get(p); },
        writeFile(p: string, content: string, opts?: { exclusive?: boolean }) {
            if (opts?.exclusive && files.has(p)) {
                const err: any = new Error('EEXIST');
                err.code = 'EEXIST';
                throw err;
            }
            files.set(p, content);
            written.push({ path: p, content, exclusive: !!opts?.exclusive });
        },
        deleteFile(p: string) { files.delete(p); },
    };
    return Object.assign(deps, overrides);
}

/** Full fs key for a session's lock file, matching the manager's path.join. */
function lockKey(deps: any, sessionFile: string): string {
    return path.join(deps.lockDir, lockFileName(sessionFile, deps.hash));
}

function lockOf(deps: any, sessionFile: string): LockFileContent | null {
    return parseLockContent(deps.files.get(lockKey(deps, sessionFile)) ?? undefined);
}

function writeForeignLock(
    deps: any,
    sessionFile: string,
    lock: Partial<LockFileContent> = { pid: 2000, acquiredAt: 9_900, heartbeatAt: 9_999 },
): void {
    const full: LockFileContent = { pid: 2000, token: 'other-token', acquiredAt: 0, heartbeatAt: 0, ...lock };
    deps.files.set(lockKey(deps, sessionFile), JSON.stringify(full));
}

describe('lockFileName', () => {
    it('derives a deterministic name from the session file path', () => {
        expect(lockFileName('/s/a.jsonl', (s) => `h(${s})`)).toBe('h(/s/a.jsonl).lock');
    });
});

describe('parseLockContent', () => {
    it('parses a well-formed lock file', () => {
        const lock = parseLockContent(JSON.stringify({ pid: 42, token: 't', acquiredAt: 1, heartbeatAt: 2 }));
        expect(lock).toEqual({ pid: 42, token: 't', acquiredAt: 1, heartbeatAt: 2 });
    });

    it('returns null for missing or corrupt content', () => {
        expect(parseLockContent(undefined)).toBeNull();
        expect(parseLockContent('')).toBeNull();
        expect(parseLockContent('not json')).toBeNull();
        expect(parseLockContent('{"pid":"x"}')).toBeNull();
    });

    it('requires a non-empty token so legacy locks cannot fake ownership', () => {
        expect(parseLockContent('{"pid":1,"token":"","acquiredAt":1,"heartbeatAt":2}')).toBeNull();
        expect(parseLockContent('{"pid":1,"acquiredAt":1,"heartbeatAt":2}')).toBeNull();
    });
});

describe('isLockStale', () => {
    it('is stale when the heartbeat is older than the threshold', () => {
        const lock = { pid: 1000, token: 't', acquiredAt: 0, heartbeatAt: 0 };
        expect(isLockStale(lock, LOCK_STALE_MS + 1, () => true)).toBe(true);
        expect(isLockStale(lock, LOCK_STALE_MS, () => true)).toBe(false);
    });

    it('is stale when the owning process is gone, regardless of heartbeat', () => {
        const lock = { pid: 1000, token: 't', acquiredAt: 0, heartbeatAt: 999 };
        expect(isLockStale(lock, 1, () => false)).toBe(true);
    });
});

describe('SessionLockManager.adopt', () => {
    it('acquires an uncontended session and reports full access', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);

        await manager.adopt('/s/a.jsonl');

        expect(manager.occupancy).toBe('none');
        const lock = lockOf(deps, '/s/a.jsonl');
        expect(lock?.pid).toBe(process.pid);
        expect(typeof lock?.token).toBe('string');
        expect((lock?.token ?? '').length).toBeGreaterThan(0);
    });

    it('reports occupied when another live process holds a fresh lock', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        writeForeignLock(deps, '/s/a.jsonl');

        await manager.adopt('/s/a.jsonl');

        expect(manager.occupancy).toBe('occupiedByOther');
        // The foreign lock is untouched.
        expect(lockOf(deps, '/s/a.jsonl')?.pid).toBe(2000);
        expect(deps.written).toHaveLength(0);
    });

    it('takes over a stale lock (dead pid)', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        writeForeignLock(deps, '/s/a.jsonl', { pid: 9999 });

        await manager.adopt('/s/a.jsonl');

        expect(manager.occupancy).toBe('none');
        expect(lockOf(deps, '/s/a.jsonl')?.pid).toBe(process.pid);
    });

    it('takes over a stale lock (heartbeat expired)', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        now.value = 10_000 + LOCK_STALE_MS + 1;
        writeForeignLock(deps, '/s/a.jsonl', { heartbeatAt: 10_000 });

        await manager.adopt('/s/a.jsonl');

        expect(manager.occupancy).toBe('none');
        expect(lockOf(deps, '/s/a.jsonl')?.pid).toBe(process.pid);
    });

    it('treats a corrupt lock file as unowned and takes over', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        deps.files.set(lockKey(deps, '/s/a.jsonl'), 'garbage');

        await manager.adopt('/s/a.jsonl');

        expect(manager.occupancy).toBe('none');
        expect(lockOf(deps, '/s/a.jsonl')).not.toBeNull();
    });

    it('releases the previously adopted session when switching files', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);

        await manager.adopt('/s/a.jsonl');
        await manager.adopt('/s/b.jsonl');

        expect(deps.files.has(lockKey(deps, '/s/a.jsonl'))).toBe(false);
        expect(lockOf(deps, '/s/b.jsonl')?.pid).toBe(process.pid);
    });

    it('serializes concurrent adopts so a later one wins', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        // The slow readFile holds the first adopt inside its critical section.
        let releaseRead!: () => void;
        const gate = new Promise<void>((r) => { releaseRead = r; });
        deps.readFile = async (p: string) => {
            await gate;
            return deps.files.get(p);
        };

        const first = manager.adopt('/s/a.jsonl');
        const second = manager.adopt('/s/b.jsonl');
        releaseRead();
        await Promise.all([first, second]);

        expect(manager.sessionFile).toBe('/s/b.jsonl');
        // The serialized second adopt released the first session's lock.
        expect(deps.files.has(lockKey(deps, '/s/a.jsonl'))).toBe(false);
        expect(deps.files.has(lockKey(deps, '/s/b.jsonl'))).toBe(true);
    });

    it('loses the race when another manager exclusive-creates first', async () => {
        const deps = makeDeps();
        const winner = new SessionLockManager(deps);
        const loser = new SessionLockManager(deps);

        await Promise.all([winner.adopt('/s/a.jsonl'), loser.adopt('/s/a.jsonl')]);

        // Both complete; the exclusive create decides who owns the lock.
        expect(lockOf(deps, '/s/a.jsonl')).not.toBeNull();
        // Exactly one of the two reports full access — no silent double-writer.
        const occupancies = [winner.occupancy, loser.occupancy].sort();
        expect(occupancies).toEqual(['none', 'occupiedByOther']);
    });
});

describe('SessionLockManager.heartbeat', () => {
    it('refreshes the heartbeat while the lock is owned', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        await manager.adopt('/s/a.jsonl');

        now.value = 20_000;
        await manager.heartbeat();

        expect(lockOf(deps, '/s/a.jsonl')?.heartbeatAt).toBe(20_000);
        expect(manager.occupancy).toBe('none');
    });

    it('preserves acquiredAt across heartbeats', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        await manager.adopt('/s/a.jsonl');
        const acquiredAt = lockOf(deps, '/s/a.jsonl')?.acquiredAt;

        now.value = 20_000;
        await manager.heartbeat();

        expect(lockOf(deps, '/s/a.jsonl')?.acquiredAt).toBe(acquiredAt);
    });

    it('detects a takeover by token mismatch and flips to read-only', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        await manager.adopt('/s/a.jsonl');

        // Another process took the lock over (rewrote it with its own token).
        writeForeignLock(deps, '/s/a.jsonl', { pid: process.pid, acquiredAt: 10_000, heartbeatAt: 20_000 });
        deps.written.length = 0;
        now.value = 25_000;
        await manager.heartbeat();

        expect(manager.occupancy).toBe('lostLock');
        expect(deps.written).toHaveLength(0);
    });

    it('recovers ownership after the occupier releases the lock', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        writeForeignLock(deps, '/s/a.jsonl');
        await manager.adopt('/s/a.jsonl');
        expect(manager.occupancy).toBe('occupiedByOther');

        deps.files.delete(lockKey(deps, '/s/a.jsonl'));
        await manager.heartbeat();

        expect(manager.occupancy).toBe('releasedByOther');
        // Recovery stays a user action — the lock is not silently re-acquired.
        expect(deps.written).toHaveLength(0);
    });

    it('flags a stale occupier so the UI can offer recovery', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        writeForeignLock(deps, '/s/a.jsonl');
        await manager.adopt('/s/a.jsonl');

        deps.alivePids.delete(2000);
        await manager.heartbeat();

        expect(manager.occupancy).toBe('releasedByOther');
    });

    it('keeps reporting occupied while the other window stays alive', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        writeForeignLock(deps, '/s/a.jsonl');
        await manager.adopt('/s/a.jsonl');

        await manager.heartbeat();

        expect(manager.occupancy).toBe('occupiedByOther');
    });

    it('is a no-op when no session is adopted', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);

        await expect(manager.heartbeat()).resolves.toBeUndefined();
        expect(deps.written).toHaveLength(0);
    });
});

describe('SessionLockManager.takeover and release', () => {
    it('takeover claims the lock from the other window and restores write access', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        writeForeignLock(deps, '/s/a.jsonl');
        await manager.adopt('/s/a.jsonl');
        expect(manager.occupancy).toBe('occupiedByOther');

        await manager.takeover();

        expect(manager.occupancy).toBe('none');
        expect(lockOf(deps, '/s/a.jsonl')?.pid).toBe(process.pid);
        expect(lockOf(deps, '/s/a.jsonl')?.token).not.toBe('other-token');
    });

    it('takeover is detected by the displaced owner via token mismatch', async () => {
        const deps = makeDeps();
        const owner = new SessionLockManager(deps);
        const taker = new SessionLockManager(deps);
        await owner.adopt('/s/a.jsonl');
        expect(owner.occupancy).toBe('none');

        // The other window opened the same session (read-only), then took over.
        await taker.adopt('/s/a.jsonl');
        expect(taker.occupancy).toBe('occupiedByOther');
        await taker.takeover();
        await owner.heartbeat();

        expect(owner.occupancy).toBe('lostLock');
        expect(taker.occupancy).toBe('none');
    });

    it('release removes a self-owned lock', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        await manager.adopt('/s/a.jsonl');

        await manager.release();

        expect(deps.files.has(lockKey(deps, '/s/a.jsonl'))).toBe(false);
    });

    it('release never deletes a foreign lock', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        const foreign = JSON.stringify({ pid: 2000, token: 'other', acquiredAt: 1, heartbeatAt: 2 } satisfies LockFileContent);
        deps.files.set(lockKey(deps, '/s/a.jsonl'), foreign);

        await manager.release();

        expect(deps.files.get(lockKey(deps, '/s/a.jsonl'))).toBe(foreign);
    });

    it('release without an adopted session is a no-op', async () => {
        const deps = makeDeps();
        const manager = new SessionLockManager(deps);
        await expect(manager.release()).resolves.toBeUndefined();
    });
});
