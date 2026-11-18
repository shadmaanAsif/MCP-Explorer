// Stage 11.2: the SessionStore on Redis. One key per session holding the record
// as JSON, with an expiry that every use pushes forward (decision D4), so Redis
// itself forgets idle sessions even when no instance is holding them.
import { StoreUnavailableError, type SessionRecord, type SessionStore } from './session-store.js';

// The few Redis commands this store needs. ioredis satisfies it; tests pass a
// fake, so the contract runs without a Redis server.
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class RedisSessionStore implements SessionStore {
  constructor(
    private redis: RedisLike,
    private ttlMs: number,
    private prefix = 'mcp:session:'
  ) {}

  private key(id: string) {
    return `${this.prefix}${id}`;
  }

  // Any Redis failure becomes StoreUnavailableError. The original error is not
  // attached: it can contain the connection URL, which can hold a password.
  private async run<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch {
      throw new StoreUnavailableError();
    }
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const raw = await this.run(() => this.redis.get(this.key(id)));
    return raw ? (JSON.parse(raw) as SessionRecord) : undefined;
  }

  async set(record: SessionRecord): Promise<void> {
    await this.run(() => this.redis.set(this.key(record.id), JSON.stringify(record), 'PX', this.ttlMs));
  }

  // Read, change lastSeen, write back with a fresh expiry. Not atomic: two
  // instances touching at once may both write, and the later write wins, which
  // only moves lastSeen by milliseconds.
  async touch(id: string, now: number = Date.now()): Promise<void> {
    const record = await this.get(id);
    if (record) await this.set({ ...record, lastSeen: now });
  }

  async delete(id: string): Promise<void> {
    await this.run(() => this.redis.del(this.key(id)));
  }
}
