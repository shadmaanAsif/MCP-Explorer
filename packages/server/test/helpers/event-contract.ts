// One contract every EventBackend must meet: memory, Redis with a fake client,
// and real Redis (when REDIS_URL is set).
import { describe, expect, it } from 'vitest';
import type { EventBackend } from '../../src/event-store.js';

const msg = (n: number) => ({ jsonrpc: '2.0' as const, method: 'notifications/progress', params: { n } });

export function eventBackendContract(name: string, make: () => EventBackend | Promise<EventBackend>) {
  describe(`EventBackend contract: ${name}`, () => {
    it('numbers events 1, 2, 3 per stream', async () => {
      const b = await make();
      const s = `s-${Math.random()}`;
      expect(await b.append(s, msg(1))).toBe(1);
      expect(await b.append(s, msg(2))).toBe(2);
      expect(await b.append(s, msg(3))).toBe(3);
    });

    it('returns only the events after a number, oldest first', async () => {
      const b = await make();
      const s = `s-${Math.random()}`;
      for (const n of [1, 2, 3, 4]) await b.append(s, msg(n));
      const after = await b.after(s, 2);
      expect(after.map((e) => e.seq)).toEqual([3, 4]);
      expect(after[0].message).toEqual(msg(3));
    });

    it('keeps streams apart', async () => {
      const b = await make();
      const x = `x-${Math.random()}`;
      const y = `y-${Math.random()}`;
      await b.append(x, msg(1));
      await b.append(y, msg(9));
      expect((await b.after(x, 0)).map((e) => e.message)).toEqual([msg(1)]);
      expect((await b.after(y, 0)).map((e) => e.message)).toEqual([msg(9)]);
    });

    it('returns nothing for an unknown stream', async () => {
      expect(await (await make()).after(`none-${Math.random()}`, 0)).toEqual([]);
    });

    it('reports the highest number given to a stream, and 0 for an unknown one', async () => {
      const b = await make();
      const s = `s-${Math.random()}`;
      expect(await b.lastSeq(s)).toBe(0);
      for (const n of [1, 2, 3]) await b.append(s, msg(n));
      expect(await b.lastSeq(s)).toBe(3);
    });
  });
}
