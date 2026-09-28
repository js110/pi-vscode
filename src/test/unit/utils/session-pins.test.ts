import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';

import { createSessionPins, inMemorySessionPins } from '../../../utils/session-pins';

describe('inMemorySessionPins', () => {
    it('toggles pin state', async () => {
        const pins = inMemorySessionPins();
        const p = '/tmp/a.session.json';
        expect((await pins.load()).has(p)).toBe(false);
        await pins.set(p, true);
        expect((await pins.load()).has(p)).toBe(true);
        await pins.set(p, false);
        expect((await pins.load()).has(p)).toBe(false);
    });
});

describe('createSessionPins', () => {
    it('persists pins to JSON across instances', async () => {
        const file = path.join(os.tmpdir(), `pi-pins-${Date.now()}-${Math.random()}.json`);
        const a = createSessionPins(file);
        await a.set('/w/a.session.json', true);
        await a.set('/w/b.session.json', true);
        await a.set('/w/a.session.json', false);

        const b = createSessionPins(file);
        const loaded = await b.load();
        expect(loaded.has('/w/a.session.json')).toBe(false);
        expect(loaded.has('/w/b.session.json')).toBe(true);
    });

    it('falls back to in-memory pins when the file cannot be persisted', async () => {
        // Block the JSON path by making its parent a *file* so mkdir fails.
        const blocker = path.join(os.tmpdir(), `pi-pins-blocker-${Date.now()}-${Math.random()}.txt`);
        await import('fs').then((fs) => fs.promises.writeFile(blocker, 'x'));
        const pins = createSessionPins(path.join(blocker, 'pins.json'));
        expect((await pins.load()).size).toBe(0);
        await pins.set('/x', true);
        expect((await pins.load()).has('/x')).toBe(true);
    });
});