/** Tiny TTL cache: skips repeated expensive reads (session list scans). */
export class TtlCache<V> {
    private _entry: { key: string; value: V; at: number } | undefined;

    constructor(
        private _ttlMs: number,
        private _opts: { now?: () => number } = {},
    ) {}

    private _now(): number {
        return this._opts.now ? this._opts.now() : Date.now();
    }

    /** Fresh value for `key`, or undefined (expired / invalidated / other key). */
    get(key: string): V | undefined {
        const e = this._entry;
        if (!e || e.key !== key) return undefined;
        if (this._now() - e.at > this._ttlMs) {
            this._entry = undefined;
            return undefined;
        }
        return e.value;
    }

    set(key: string, value: V): void {
        this._entry = { key, value, at: this._now() };
    }

    invalidate(): void {
        this._entry = undefined;
    }
}
