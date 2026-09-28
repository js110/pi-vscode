/**
 * Pinned session paths, persisted as a JSON array under global storage.
 * Falls back to an in-memory set when the file is unreadable/writable.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SessionPins {
    load(): Promise<Set<string>>;
    set(sessionPath: string, pinned: boolean): Promise<void>;
}

function inMemoryPins(): SessionPins {
    const mem = new Set<string>();
    return {
        load: async () => new Set(mem),
        set: async (p, pinned) => {
            if (pinned) { mem.add(p); } else { mem.delete(p); }
        },
    };
}

export function createSessionPins(jsonPath: string): SessionPins {
    let cached: Set<string> | null = null;

    async function read(): Promise<Set<string>> {
        if (cached) return new Set(cached);
        try {
            const raw = await fs.promises.readFile(jsonPath, 'utf-8');
            const arr: unknown = JSON.parse(raw);
            cached = new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
        } catch {
            cached = new Set();
        }
        return new Set(cached);
    }

    async function write(): Promise<void> {
        const next = cached ?? new Set<string>();
        try {
            await fs.promises.mkdir(path.dirname(jsonPath), { recursive: true });
            await fs.promises.writeFile(jsonPath, JSON.stringify([...next], null, 2), 'utf-8');
        } catch { /* non-persistent pins are acceptable */ }
    }

    return {
        load: () => read(),
        set: async (p, pinned) => {
            const cur = await read();
            if (pinned) { cur.add(p); } else { cur.delete(p); }
            cached = cur;
            await write();
        },
    };
}

/** Default fallback used when the host supplies no pin store. */
export function inMemorySessionPins(): SessionPins {
    return inMemoryPins();
}