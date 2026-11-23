// Stage 11.2: the Redis store. The same contract runs three ways: against a fake
// client (always), and against a real Redis when REDIS_URL is set (D6).
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { StoreUnavailableError } from '../src/session-store.js';
import { RedisSessionStore, type RedisLike } from '../src/session-store-redis.js';
import { record, storeContract } from './helpers/store-contract.js';

// A Map that remembers the expiry each key was last given, and can be told to fail.
class FakeRedis implements RedisLike {
  data = new Map<string, { value: string; ttl: number }>();
  failWith?: Error;
  async get(key: string) {
    if (this.failWith) throw this.failWith;
    return this.data.get(key)?.value ?? null;
  }
  async set(key: string, value: string, _mode: 'PX', ms: number) {
    if (this.failWith) throw this.failWith;
    this.data.set(key, { value, ttl: ms });
  }
  async del(key: string) {
    if (this.failWith) throw this.failWith;
    this.data.delete(key);
  }
}

storeContract('redis store on a fake client', () => new RedisSessionStore(new FakeRedis(), 60_000));

describe('RedisSessionStore', () => {
  it('stores one JSON value per session under a prefix, with the expiry', async () => {
    const fake = new FakeRedis();
    await new RedisSessionStore(fake, 1234).set(record('a'));
    const entry = fake.data.get('mcp:session:a');
    expect(entry?.ttl).toBe(1234);
    expect(JSON.parse(entry!.value)).toEqual(record('a'));
  });

  it('touch gives the key a fresh expiry', async () => {
    const fake = new FakeRedis();
    const store = new RedisSessionStore(fake, 1234);
    await store.set(record('a'));
    fake.data.get('mcp:session:a')!.ttl = 1; // pretend it was nearly expired
    await store.touch('a', 9000);
    expect(fake.data.get('mcp:session:a')?.ttl).toBe(1234);
  });

  it('turns a Redis failure into StoreUnavailableError without leaking the original message', async () => {
    const fake = new FakeRedis();
    fake.failWith = new Error('connect ECONNREFUSED redis://user:s3cret@host:6379');
    const store = new RedisSessionStore(fake, 1000);
    for (const op of [() => store.get('a'), () => store.set(record('a')), () => store.touch('a'), () => store.delete('a')]) {
      const error = await op().then(
        () => undefined,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(StoreUnavailableError);
      expect(String((error as Error).message)).not.toContain('s3cret');
    }
  });
});

// Real Redis. Skipped (and shown as skipped) when REDIS_URL is not set.
describe.skipIf(!process.env.REDIS_URL)('RedisSessionStore on a real Redis', () => {
  let redis: Redis | undefined;
  const prefix = `test:${process.pid}:${Date.now()}:`;
  const real = () => {
    redis ??= new Redis(process.env.REDIS_URL!);
    return new RedisSessionStore(redis, 60_000, prefix);
  };
  storeContract('real redis', real);

  it('lets a key expire on its own', async () => {
    redis ??= new Redis(process.env.REDIS_URL!);
    const store = new RedisSessionStore(redis, 150, prefix);
    await store.set(record('short'));
    expect(await store.get('short')).toBeDefined();
    await new Promise((r) => setTimeout(r, 400));
    expect(await store.get('short')).toBeUndefined();
    await redis.quit();
  });
});
