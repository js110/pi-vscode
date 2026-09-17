import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionOccupancy } from '../shared/protocol';

/**
 * Single-writer session locking (PRD 9.8, AC-OP-03) — a presentation-layer
 * marker only, no new session state machine state. Lock files live under the
 * extension's globalStorage dir; ~/.pi/agent is never written (PRD red line).
 *
 * All fs access and pid probing is injected so the manager is unit-testable.
 * Ownership is (pid, token): the token distinguishes two tabs in the SAME
 * window (same pid), so same-window takeover is detected exactly like a
 * cross-window one.
 */

export interface LockFileContent {
    pid: number;
    token: string;
    acquiredAt: number;
    heartbeatAt: number;
}

export type { SessionOccupancy };

export interface SessionLockDeps {
    lockDir: string;
    isProcessAlive(pid: number): boolean;
    now(): number;
    hash(s: string): string;
    newToken(): string;
    readFile(p: string): Promise<string | undefined>;
    /** exclusive uses the OS exclusive-create flag; EEXIST must surface. */
    writeFile(p: string, content: string, opts?: { exclusive?: boolean }): Promise<void>;
    deleteFile(p: string): Promise<void>;
}

/** A lock older than this (or with a dead pid) is considered abandoned. */
export const LOCK_STALE_MS = 45_000;

export const LOCK_HEARTBEAT_MS = 15_000;

export function lockFileName(sessionFile: string, hash: (s: string) => string): string {
    return `${hash(sessionFile)}.lock`;
}

export function parseLockContent(raw: string | undefined): LockFileContent | null {
    if (!raw) { return null; }
    try {
        const parsed = JSON.parse(raw) as Partial<LockFileContent> | null;
        if (parsed === null || typeof parsed !== 'object') { return null; }
        if (typeof parsed.pid !== 'number'
            || typeof parsed.token !== 'string' || parsed.token === ''
            || typeof parsed.acquiredAt !== 'number'
            || typeof parsed.heartbeatAt !== 'number') {
            return null;
        }
        return { pid: parsed.pid, token: parsed.token, acquiredAt: parsed.acquiredAt, heartbeatAt: parsed.heartbeatAt };
    } catch {
        return null;
    }
}

export function isLockStale(
    lock: LockFileContent,
    nowMs: number,
    alive: (pid: number) => boolean,
): boolean {
    if (!alive(lock.pid)) { return true; }
    // A heartbeat stamped in the future means the lock is corrupt/moved clocks —
    // treat it as abandoned rather than letting it pin the slot forever.
    if (lock.heartbeatAt > nowMs + LOCK_STALE_MS) { return true; }
    return nowMs - lock.heartbeatAt > LOCK_STALE_MS;
}

export class SessionLockManager {
    private _sessionFile: string | undefined;
    private _occupancy: SessionOccupancy = 'none';
    private readonly _token: string;
    /** Serializes adopt/takeover/release/heartbeat so awaits cannot interleave. */
    private _queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly _deps: SessionLockDeps) {
        this._token = _deps.newToken();
    }

    get sessionFile(): string | undefined {
        return this._sessionFile;
    }

    get occupancy(): SessionOccupancy {
        return this._occupancy;
    }

    private get lockPath(): string | undefined {
        return this._sessionFile
            ? path.join(this._deps.lockDir, lockFileName(this._sessionFile, this._deps.hash))
            : undefined;
    }

    private _run<T>(fn: () => Promise<T>): Promise<T> {
        const next = this._queue.then(fn, fn);
        this._queue = next.catch(() => { /* keep the chain alive */ });
        return next;
    }

    private _owns(existing: LockFileContent): boolean {
        return existing.pid === process.pid && existing.token === this._token;
    }

    /**
     * Start tracking a session file: releases any previously held lock and
     * acquires this one. Contention only flips the presentation state — the
     * caller decides what read-only means for the UI.
     */
    adopt(sessionFile: string): Promise<void> {
        return this._run(() => this._adopt(sessionFile));
    }

    private async _adopt(sessionFile: string): Promise<void> {
        if (this._sessionFile === sessionFile && this._occupancy === 'none') { return; }
        await this._release();
        this._sessionFile = sessionFile;
        this._occupancy = (await this._tryAcquire()) ? 'none' : 'occupiedByOther';
    }

    private async _tryAcquire(): Promise<boolean> {
        const lockPath = this.lockPath;
        if (!lockPath) { return false; }
        const raw = await this._deps.readFile(lockPath);
        const existing = parseLockContent(raw);
        if (existing && !isLockStale(existing, this._deps.now(), (pid) => this._deps.isProcessAlive(pid))) {
            return false;
        }
        try {
            // Exclusive create closes the two-window TOCTOU window; a corrupt
            // or stale lock is removed first so the slot is genuinely free.
            if (raw !== undefined) {
                await this._deps.deleteFile(lockPath);
            }
            await this._deps.writeFile(lockPath, this._serialize(), { exclusive: true });
            return true;
        } catch (err: any) {
            if (err?.code === 'EEXIST') { return false; }
            throw err;
        }
    }

    private _serialize(): string {
        const nowMs = this._deps.now();
        return JSON.stringify({
            pid: process.pid,
            token: this._token,
            acquiredAt: nowMs,
            heartbeatAt: nowMs,
        } satisfies LockFileContent);
    }

    /** Claim the lock from the other window (user-initiated "接管/恢复可写"). */
    takeover(): Promise<void> {
        return this._run(async () => {
            const lockPath = this.lockPath;
            if (!lockPath) { return; }
            await this._deps.writeFile(lockPath, this._serialize());
            this._occupancy = 'none';
        });
    }

    /**
     * Periodic tick. As owner: verifies the lock still belongs to us (another
     * window's takeover is detected here). As a read-only observer: watches
     * for the occupier releasing or dying so the UI can offer recovery.
     */
    heartbeat(): Promise<void> {
        return this._run(() => this._heartbeat());
    }

    private async _heartbeat(): Promise<void> {
        const lockPath = this.lockPath;
        if (!lockPath) { return; }
        const existing = parseLockContent(await this._deps.readFile(lockPath));

        if (this._occupancy === 'none') {
            if (!existing || !this._owns(existing)) {
                // Taken over by another window or tab — go read-only, never fight back.
                this._occupancy = 'lostLock';
                return;
            }
            await this._deps.writeFile(lockPath, JSON.stringify({
                pid: process.pid,
                token: this._token,
                acquiredAt: existing.acquiredAt,
                heartbeatAt: this._deps.now(),
            } satisfies LockFileContent));
            return;
        }

        // Read-only observer: is the occupier still holding a live lock?
        const stale = !existing
            || isLockStale(existing, this._deps.now(), (pid) => this._deps.isProcessAlive(pid));
        this._occupancy = stale ? 'releasedByOther' : 'occupiedByOther';
    }

    /** Drop the tracked lock (only if we own it). */
    release(): Promise<void> {
        return this._run(() => this._release());
    }

    private async _release(): Promise<void> {
        const lockPath = this.lockPath;
        this._sessionFile = undefined;
        this._occupancy = 'none';
        if (!lockPath) { return; }
        const existing = parseLockContent(await this._deps.readFile(lockPath));
        if (existing && this._owns(existing)) {
            await this._deps.deleteFile(lockPath);
        }
    }
}

/** Production deps: globalStorage-backed lock dir + real fs. */
export function createNodeLockDeps(lockDir: string): SessionLockDeps {
    return {
        lockDir,
        isProcessAlive: (pid) => {
            try {
                process.kill(pid, 0);
                return true;
            } catch (err: any) {
                return err?.code === 'EPERM';
            }
        },
        now: () => Date.now(),
        hash: (s) => crypto.createHash('sha1').update(s).digest('hex'),
        newToken: () => crypto.randomUUID(),
        readFile: async (p) => {
            try {
                return await fs.promises.readFile(p, 'utf8');
            } catch {
                return undefined;
            }
        },
        writeFile: async (p, content, opts) => {
            await fs.promises.mkdir(path.dirname(p), { recursive: true });
            // Write to a temp file first, then link/rename into place: readers
            // never observe a partially-written lock, and exclusive claims stay
            // atomic (link() fails with EEXIST if the target already exists).
            const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
            await fs.promises.writeFile(tmp, content, { encoding: 'utf8' });
            try {
                if (opts?.exclusive) {
                    try {
                        await fs.promises.link(tmp, p);
                    } catch (err: any) {
                        // Filesystems without hard links (FAT/exFAT): fall back
                        // to an exclusive create preserving EEXIST semantics.
                        if (err?.code === 'EEXIST') throw err;
                        await fs.promises.writeFile(p, content, { encoding: 'utf8', flag: 'wx' });
                    }
                } else {
                    await fs.promises.rename(tmp, p);
                }
            } finally {
                await fs.promises.unlink(tmp).catch(() => { /* already moved */ });
            }
        },
        deleteFile: async (p) => {
            try {
                await fs.promises.unlink(p);
            } catch { /* already gone */ }
        },
    };
}
