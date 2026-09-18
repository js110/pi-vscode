import { describe, it, expect } from 'vitest';
import { PiSessionManager } from '../../../pi/session';

function managerWithMessages(messages: any[]): PiSessionManager {
    const manager = new PiSessionManager({ appendLine: () => undefined } as any);
    (manager as any)._session = { state: { messages } };
    return manager;
}

const user = (text: string) => ({ role: 'user', content: text });
const assistant = (text: string) => ({ role: 'assistant', content: text });

describe('PiSessionManager.findCutoffIndex', () => {
    it('returns the first user message after the rollback point', () => {
        const messages = [user('a'), assistant('a1'), user('b'), assistant('b1'), user('c')];
        expect(PiSessionManager.findCutoffIndex(messages, 0)).toBe(0);
        expect(PiSessionManager.findCutoffIndex(messages, 1)).toBe(2);
        expect(PiSessionManager.findCutoffIndex(messages, 2)).toBe(4);
    });

    it('returns -1 when no user turn lies past the point', () => {
        const messages = [user('a'), assistant('a1')];
        expect(PiSessionManager.findCutoffIndex(messages, 1)).toBe(-1);
        expect(PiSessionManager.findCutoffIndex([], 0)).toBe(-1);
    });
});

describe('PiSessionManager.rollbackTo', () => {
    it('truncates the session and returns the suspended tail', () => {
        const manager = managerWithMessages([user('a'), assistant('a1'), user('b'), assistant('b1')]);
        const result = manager.rollbackTo(1);

        expect(result.cutoff).toBe(2);
        expect(result.suspended).toEqual([user('b'), assistant('b1')]);
        expect(manager.getMessages()).toEqual([user('a'), assistant('a1')]);
    });

    it('suspends nothing when the point is at the end', () => {
        const manager = managerWithMessages([user('a'), assistant('a1')]);
        const result = manager.rollbackTo(1);

        expect(result).toEqual({ cutoff: -1, suspended: [] });
        expect(manager.getMessages()).toHaveLength(2);
    });

    it('suspends nothing for an empty session', () => {
        const manager = managerWithMessages([]);
        expect(manager.rollbackTo(0)).toEqual({ cutoff: -1, suspended: [] });
    });
});