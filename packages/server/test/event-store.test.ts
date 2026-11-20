// Stage 11.3: the event store behind resumable streams. Unit tests, no server.
import { describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import {
  MemoryEventBackend,
  RedisEventBackend,
  ScopedEventStore,
  SEQ_KEEP_FACTOR,
  type EventBackend,
  type RedisEventsLike
} from '../src/event-store.js';
import { StoreUnavailableError } from '../src/session-store.js';
import { eventBackendContract } from './helpers/event-contract.js';

const msg = (n: number) => ({ jsonrpc: '2.0' as const, method: 'notifications/progress', params: { n } });
const LIMITS = { maxEvents: 3, ttlMs: 1000 };

// A tiny in-memory stand-in for the Redis commands the backend uses, recording
// the expiry it was asked to set.
function fakeRedis() {
  const lists = new Map<string, string[]>();
  const counters = new Map<string, number>();
  const expiries = new Map<string, number>();
  const client: RedisEventsLike & { expiries: Map<string, number>; fail: boolean; dropList(key: string): void } = {
    expiries,
    fail: false,
    // Pretend Redis expired a list: the events go, the counter stays.
    dropList(key) {
      lists.delete(key);
    },
    async get(key) {
      if (client.fail) throw new Error('redis://user:secret@host down');
      return counters.has(key) ? String(counters.get(key)) : null;
    },
    async incr(key) {
      if (client.fail) throw new Error('redis://user:secret@host down');
      counters.set(key, (counters.get(key) ?? 0) + 1);
      return counters.get(key)!;
    },
    multi() {
      const ops: Array<() => void> = [];
      const tx = {
        rpush(key: string, v: string) {
          ops.push(() => lists.set(key, [...(lists.get(key) ?? []), v]));
          return tx;
        },
        ltrim(key: string, start: number, stop: number) {
          ops.push(() => {
            const l = lists.get(key) ?? [];
            lists.set(key, l.slice(start, stop === -1 ? undefined : stop + 1));
          });
          return tx;
        },
        pexpire(key: string, ms: number) {
          ops.push(() => expiries.set(key, ms));
          return tx;
        },
        async exec() {
          ops.forEach((o) => o());
          return ops.map(() => [null, 1] as [Error | null, unknown]);
        }
      };
      return tx;
    },
    async lrange(key) {
      if (client.fail) throw new Error('redis://user:secret@host down');
      return lists.get(key) ?? [];
    }
  };
  return client;
}

eventBackendContract('memory', () => new MemoryEventBackend({ maxEvents: 100, ttlMs: 60_000 }));
eventBackendContract('redis (fake client)', () => new RedisEventBackend(fakeRedis(), { maxEvents: 100, ttlMs: 60_000 }));

const REDIS_URL = process.env.REDIS_URL;
describe.skipIf(!REDIS_URL)('real Redis', () => {
  const redis = REDIS_URL ? new Redis(REDIS_URL) : undefined;
  eventBackendContract('real Redis', () => new RedisEventBackend(redis!, { maxEvents: 100, ttlMs: 60_000 }, `test:ev:${Math.random()}:`));
  it('closes', async () => {
    await redis?.quit();
  });
});

describe('limits', () => {
  it('memory keeps only the newest maxEvents', async () => {
    const b = new MemoryEventBackend(LIMITS);
    for (const n of [1, 2, 3, 4, 5]) await b.append('s', msg(n));
    expect((await b.after('s', 0)).map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('memory drops the events after their expiry but keeps counting', async () => {
    let now = 0;
    const b = new MemoryEventBackend(LIMITS, () => now);
    await b.append('s', msg(1));
    now = 1001; // events expired (ttl 1000), the counter has not (6 x ttl)
    expect(await b.after('s', 0)).toEqual([]);
    expect(await b.lastSeq('s')).toBe(1);
    expect(await b.append('s', msg(2))).toBe(2);
    expect((await b.after('s', 0)).map((e) => e.seq)).toEqual([2]);
  });

  it('memory forgets the stream completely once the counter has expired too', async () => {
    let now = 0;
    const b = new MemoryEventBackend(LIMITS, () => now);
    await b.append('s', msg(1));
    now = LIMITS.ttlMs * SEQ_KEEP_FACTOR + 1;
    expect(await b.lastSeq('s')).toBe(0);
    expect(await b.append('s', msg(2))).toBe(1);
  });

  it('memory sweeps expired streams so they do not pile up', async () => {
    let now = 0;
    const b = new MemoryEventBackend(LIMITS, () => now);
    await b.append('old', msg(1));
    await b.append('mid', msg(1));
    now = LIMITS.ttlMs + 1;
    await b.append('new', msg(1)); // sweep runs here: the events of 'old' and 'mid' go
    const streams = (b as unknown as { streams: Map<string, { events: unknown[] }> }).streams;
    expect(streams.get('old')?.events).toEqual([]);
    now = LIMITS.ttlMs * SEQ_KEEP_FACTOR + 2000;
    await b.append('newer', msg(1)); // the counters of 'old' and 'mid' have expired now
    expect(streams.has('old')).toBe(false);
    expect(streams.has('mid')).toBe(false);
  });

  it('redis trims to maxEvents and sets an expiry on the list and the counter', async () => {
    const r = fakeRedis();
    const b = new RedisEventBackend(r, LIMITS);
    for (const n of [1, 2, 3, 4, 5]) await b.append('s', msg(n));
    expect((await b.after('s', 0)).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(r.expiries.get('mcp:events:s')).toBe(1000);
    expect(r.expiries.get('mcp:events:s:seq')).toBe(1000 * SEQ_KEEP_FACTOR); // the counter outlives the events
  });

  it('redis failures become StoreUnavailableError without leaking the original message', async () => {
    const r = fakeRedis();
    r.fail = true;
    const b = new RedisEventBackend(r, LIMITS);
    const err = await b.append('s', msg(1)).catch((e) => e);
    expect(err).toBeInstanceOf(StoreUnavailableError);
    expect(String(err.message)).not.toContain('secret');
  });
});

describe('ScopedEventStore', () => {
  const make = (backend: EventBackend, sid: string | undefined = 'sess-1') => new ScopedEventStore(backend, () => sid);
  const collect = async (store: ScopedEventStore, lastId: string) => {
    const seen: Array<[string, unknown]> = [];
    const streamId = await store.replayEventsAfter(lastId, { send: async (id, m) => void seen.push([id, m]) });
    return { streamId, seen };
  };

  it('builds ids from session, stream and sequence, and replays the later events', async () => {
    const store = make(new MemoryEventBackend({ maxEvents: 50, ttlMs: 60_000 }));
    const id1 = await store.storeEvent('stream-a', msg(1));
    const id2 = await store.storeEvent('stream-a', msg(2));
    const id3 = await store.storeEvent('stream-a', msg(3));
    expect(id1).toBe('sess-1~stream-a~1');
    const { streamId, seen } = await collect(store, id1);
    expect(streamId).toBe('stream-a');
    expect(seen).toEqual([
      [id2, msg(2)],
      [id3, msg(3)]
    ]);
  });

  it('works with the standalone stream id that contains underscores', async () => {
    const store = make(new MemoryEventBackend({ maxEvents: 50, ttlMs: 60_000 }));
    const id = await store.storeEvent('_GET_stream', msg(1));
    await store.storeEvent('_GET_stream', msg(2));
    expect(await store.getStreamIdForEventId(id)).toBe('_GET_stream');
    expect((await collect(store, id)).seen).toHaveLength(1);
  });

  it('never replays the empty priming event', async () => {
    const store = make(new MemoryEventBackend({ maxEvents: 50, ttlMs: 60_000 }));
    const first = await store.storeEvent('s', msg(1));
    await store.storeEvent('s', {} as never); // priming
    await store.storeEvent('s', msg(3));
    expect((await collect(store, first)).seen.map(([, m]) => m)).toEqual([msg(3)]);
  });

  it("refuses another session's event ids", async () => {
    const backend = new MemoryEventBackend({ maxEvents: 50, ttlMs: 60_000 });
    const a = make(backend, 'sess-a');
    const b = make(backend, 'sess-b');
    const id = await a.storeEvent('_GET_stream', msg(1));
    await a.storeEvent('_GET_stream', msg(2));
    expect(await b.getStreamIdForEventId(id)).toBeUndefined();
    await expect(collect(b, id)).rejects.toThrow('Invalid event ID');
  });

  it.each(['', 'nonsense', 'a~b', 'sess-1~s~x', 'sess-1~s~1~2'])('refuses a malformed id: %j', async (bad) => {
    const store = make(new MemoryEventBackend({ maxEvents: 50, ttlMs: 60_000 }));
    expect(await store.getStreamIdForEventId(bad)).toBeUndefined();
    await expect(collect(store, bad)).rejects.toThrow('Invalid event ID');
  });

  it('fails loudly when older events were dropped, instead of skipping messages', async () => {
    const store = make(new MemoryEventBackend({ maxEvents: 2, ttlMs: 60_000 }));
    const first = await store.storeEvent('s', msg(1));
    for (const n of [2, 3, 4]) await store.storeEvent('s', msg(n)); // 1 and 2 dropped
    await expect(collect(store, first)).rejects.toThrow('no longer stored');
  });

  it('refuses a replay when ALL the events expired, but accepts a client that is up to date (memory)', async () => {
    let now = 0;
    const store = make(new MemoryEventBackend({ maxEvents: 50, ttlMs: 1000 }, () => now));
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push(await store.storeEvent('s', msg(n)));
    now = 1001; // every event expired
    await expect(collect(store, ids[1])).rejects.toThrow('no longer stored'); // missed event 3
    const upToDate = await collect(store, ids[2]); // had everything: nothing to replay, no error
    expect(upToDate.seen).toEqual([]);
  });

  it('refuses a replay when the Redis list expired but the counter is still there', async () => {
    const r = fakeRedis();
    const store = make(new RedisEventBackend(r, { maxEvents: 50, ttlMs: 1000 }));
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push(await store.storeEvent('s', msg(n)));
    const streamId = ids[0].split('~')[1];
    r.dropList(`mcp:events:sess-1~${streamId}`); // what Redis does after the list's expiry
    await expect(collect(store, ids[0])).rejects.toThrow('no longer stored');
    expect((await collect(store, ids[2])).seen).toEqual([]);
  });

  it('logs the refusal when everything expired', async () => {
    let now = 0;
    const lines: string[] = [];
    const store = new ScopedEventStore(new MemoryEventBackend({ maxEvents: 50, ttlMs: 1000 }, () => now), () => 'sess-1', (l) => lines.push(l));
    const first = await store.storeEvent('s', msg(1));
    await store.storeEvent('s', msg(2));
    now = 1001;
    await expect(collect(store, first)).rejects.toThrow('no longer stored');
    expect(lines.some((l) => l.startsWith('replay refused: events after ') && l.endsWith('are no longer stored'))).toBe(true);
  });

  it('logs one line per stored and replayed event, with no message content (Stage 11.3 debug)', async () => {
    const lines: string[] = [];
    const store = new ScopedEventStore(
      new MemoryEventBackend({ maxEvents: 50, ttlMs: 60_000 }),
      () => 'S1',
      (l) => lines.push(l)
    );
    const prime = await store.storeEvent('A', {} as never);
    await store.storeEvent('A', {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'p', progress: 1, total: 3, message: 'secret-place done' }
    });
    await store.storeEvent('A', { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'secret-place' }] } });
    await store.replayEventsAfter(prime, { send: async () => {} });
    await expect(store.getStreamIdForEventId('S2~A~1')).resolves.toBeUndefined();
    expect(lines).toEqual([
      'event stored S1~A~1 (priming event)',
      'event stored S1~A~2 (progress 1/3)',
      'event stored S1~A~3 (result)',
      'replay requested after S1~A~1',
      'replay sent S1~A~2 (progress 1/3)',
      'replay sent S1~A~3 (result)',
      'replay done: 2 event(s) after S1~A~1',
      'replay refused: the event id is not from this session'
    ]);
    expect(lines.join('\n')).not.toContain('secret-place');
  });

  it('logs nothing when no logger is given', async () => {
    const quiet = make(new MemoryEventBackend({ maxEvents: 50, ttlMs: 60_000 }));
    await expect(quiet.storeEvent('A', msg(1))).resolves.toBe('sess-1~A~1');
  });

  it('reads the session id when used, not when built', async () => {
    let sid: string | undefined;
    const store = new ScopedEventStore(new MemoryEventBackend({ maxEvents: 5, ttlMs: 1000 }), () => sid);
    await expect(store.storeEvent('s', msg(1))).rejects.toThrow('before the session id exists');
    sid = 'late';
    expect(await store.storeEvent('s', msg(1))).toBe('late~s~1');
  });
});
