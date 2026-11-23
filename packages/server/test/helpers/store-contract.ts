// One contract every SessionStore must meet: memory, the Redis store with a fake
// client, and real Redis (when REDIS_URL is set). See the test files that call it.
import { describe, expect, it } from 'vitest';
import type { SessionRecord, SessionStore } from '../src/session-store.js';

export const record = (id: string, over: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  owner: 'alice',
  state: { home: { name: 'Doha', latitude: 25.3, longitude: 51.5 } },
  initializeParams: { protocolVersion: '2025-06-18', clientInfo: { name: 't', version: '0' } },
  createdAt: 1000,
  lastSeen: 1000,
  ...over
});

export function storeContract(name: string, make: () => SessionStore | Promise<SessionStore>) {
  describe(`SessionStore contract: ${name}`, () => {
    it('returns what was set, including state and initialize params', async () => {
      const s = await make();
      await s.set(record('a'));
      expect(await s.get('a')).toEqual(record('a'));
    });

    it('returns undefined for an unknown id', async () => {
      expect(await (await make()).get('nope')).toBeUndefined();
    });

    it('keeps sessions apart', async () => {
      const s = await make();
      await s.set(record('a', { owner: 'alice' }));
      await s.set(record('b', { owner: 'bob' }));
      expect((await s.get('a'))?.owner).toBe('alice');
      expect((await s.get('b'))?.owner).toBe('bob');
    });

    it('touch moves lastSeen and nothing else', async () => {
      const s = await make();
      await s.set(record('a'));
      await s.touch('a', 5000);
      expect(await s.get('a')).toEqual(record('a', { lastSeen: 5000 }));
    });

    it('touch on an unknown id does nothing and does not create it', async () => {
      const s = await make();
      await s.touch('ghost', 5000);
      expect(await s.get('ghost')).toBeUndefined();
    });

    it('delete removes a session and ignores an unknown id', async () => {
      const s = await make();
      await s.set(record('a'));
      await s.delete('a');
      await s.delete('a');
      expect(await s.get('a')).toBeUndefined();
    });

    it('set again replaces the record', async () => {
      const s = await make();
      await s.set(record('a'));
      await s.set(record('a', { owner: 'carol' }));
      expect((await s.get('a'))?.owner).toBe('carol');
    });
  });
}
