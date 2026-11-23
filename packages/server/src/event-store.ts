// Stage 11.3: resumable streams. When a client's SSE stream drops, it can
// reconnect with `Last-Event-ID` and receive the events it missed. The SDK
// asks for an EventStore; this file provides one in two layers:
//
//   EventBackend      where events are kept (memory, or Redis so any instance
//                     can replay them). Knows nothing about sessions or ids.
//   ScopedEventStore  the SDK's EventStore for ONE session. It builds the event
//                     ids and refuses ids that belong to another session.
//
// Every stream is bounded: a maximum number of events, and an expiry.
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { EventStore } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { StoreUnavailableError } from './session-store.js';

export type EventEntry = { seq: number; message: JSONRPCMessage };

export interface EventBackend {
  /** Appends an event to a stream and returns its sequence number (1, 2, 3…). */
  append(scope: string, message: JSONRPCMessage): Promise<number>;
  /** Events with a sequence number greater than `seq`, oldest first. */
  after(scope: string, seq: number): Promise<EventEntry[]>;
  /**
   * The highest sequence number ever given to a stream, or 0 if the stream is
   * unknown. It outlives the events, so a replay can tell "nothing newer" apart
   * from "the events expired".
   */
  lastSeq(scope: string): Promise<number>;
}

export type EventLimits = { maxEvents: number; ttlMs: number };

// The counter is a single number, so it is kept longer than the events: 6 times
// the event expiry, which is 30 minutes at the default 5 (the default idle
// session time). After that the stream is forgotten completely.
export const SEQ_KEEP_FACTOR = 6;

// ---- memory -------------------------------------------------------------

type MemoryStream = { lastSeq: number; events: EventEntry[]; expiresAt: number; seqExpiresAt: number };

export class MemoryEventBackend implements EventBackend {
  private streams = new Map<string, MemoryStream>();
  private lastSweep = 0;

  constructor(
    private limits: EventLimits,
    private now: () => number = Date.now
  ) {}

  private sweep() {
    const now = this.now();
    // At most once a second: a sweep walks every stream.
    if (now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    for (const [scope, s] of this.streams) {
      if (s.seqExpiresAt <= now) this.streams.delete(scope);
      else if (s.expiresAt <= now) s.events = []; // the events expired; the counter stays
    }
  }

  async append(scope: string, message: JSONRPCMessage): Promise<number> {
    this.sweep();
    const now = this.now();
    let stream = this.streams.get(scope);
    if (!stream || stream.seqExpiresAt <= now) {
      stream = { lastSeq: 0, events: [], expiresAt: 0, seqExpiresAt: 0 };
      this.streams.set(scope, stream);
    } else if (stream.expiresAt <= now) {
      stream.events = []; // numbering carries on, so a late client sees a gap
    }
    stream.lastSeq += 1;
    stream.events.push({ seq: stream.lastSeq, message });
    // Keep only the newest `maxEvents`.
    if (stream.events.length > this.limits.maxEvents) stream.events.splice(0, stream.events.length - this.limits.maxEvents);
    stream.expiresAt = now + this.limits.ttlMs;
    stream.seqExpiresAt = now + this.limits.ttlMs * SEQ_KEEP_FACTOR;
    return stream.lastSeq;
  }

  async after(scope: string, seq: number): Promise<EventEntry[]> {
    const stream = this.streams.get(scope);
    if (!stream || stream.expiresAt <= this.now()) return [];
    return stream.events.filter((e) => e.seq > seq);
  }

  async lastSeq(scope: string): Promise<number> {
    const stream = this.streams.get(scope);
    return stream && stream.seqExpiresAt > this.now() ? stream.lastSeq : 0;
  }
}

// ---- Redis --------------------------------------------------------------

// The few Redis commands this backend needs. ioredis satisfies it; tests pass
// a fake so the logic runs without a Redis server.
export interface RedisEventsLike {
  incr(key: string): Promise<number>;
  multi(): {
    rpush(key: string, value: string): unknown;
    ltrim(key: string, start: number, stop: number): unknown;
    pexpire(key: string, ms: number): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  get(key: string): Promise<string | null>;
}

export class RedisEventBackend implements EventBackend {
  constructor(
    private redis: RedisEventsLike,
    private limits: EventLimits,
    private prefix = 'mcp:events:'
  ) {}

  // A Redis failure becomes StoreUnavailableError; the original error can hold
  // the connection URL, so it is not attached.
  private async run<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch {
      throw new StoreUnavailableError();
    }
  }

  async append(scope: string, message: JSONRPCMessage): Promise<number> {
    return this.run(async () => {
      const seqKey = `${this.prefix}${scope}:seq`;
      const listKey = `${this.prefix}${scope}`;
      const seq = await this.redis.incr(seqKey);
      const tx = this.redis.multi();
      tx.rpush(listKey, JSON.stringify({ seq, message }));
      tx.ltrim(listKey, -this.limits.maxEvents, -1);
      tx.pexpire(listKey, this.limits.ttlMs);
      tx.pexpire(seqKey, this.limits.ttlMs * SEQ_KEEP_FACTOR); // outlives the events
      const results = await tx.exec();
      if (!results || results.some(([err]) => err)) throw new Error('transaction failed');
      return seq;
    });
  }

  async after(scope: string, seq: number): Promise<EventEntry[]> {
    return this.run(async () => {
      const raw = await this.redis.lrange(`${this.prefix}${scope}`, 0, -1);
      return raw
        .map((r) => JSON.parse(r) as EventEntry)
        .filter((e) => e.seq > seq)
        .sort((a, b) => a.seq - b.seq);
    });
  }

  async lastSeq(scope: string): Promise<number> {
    return this.run(async () => {
      const raw = await this.redis.get(`${this.prefix}${scope}:seq`);
      return raw ? Number(raw) : 0;
    });
  }
}

// ---- the SDK's EventStore, for one session ------------------------------

// Event id = `<sessionId>~<streamId>~<seq>`. The session id inside the id and
// the check below stop one session from replaying another's events (stream ids
// such as the standalone `_GET_stream` are the same in every session).
function parseEventId(eventId: string): { sessionId: string; streamId: string; seq: number } | undefined {
  const parts = eventId.split('~');
  if (parts.length !== 3 || !/^\d+$/.test(parts[2])) return undefined;
  return { sessionId: parts[0], streamId: parts[1], seq: Number(parts[2]) };
}

// What a debug line says about a message. Method names and progress counts only:
// never the content, which can hold what the user asked for.
function describe(message: JSONRPCMessage): string {
  if (Object.keys(message).length === 0) return 'priming event';
  if ('method' in message) {
    const p = (message as { params?: { progress?: number; total?: number } }).params;
    return message.method === 'notifications/progress' && p?.progress !== undefined
      ? `progress ${p.progress}${p.total !== undefined ? `/${p.total}` : ''}`
      : message.method;
  }
  return 'error' in message ? 'error' : 'result';
}

export class ScopedEventStore implements EventStore {
  /**
   * `sessionId` is read on each call: the id only exists once initialize ran.
   * `log` (optional) gets one line per event stored or replayed; off when absent.
   */
  constructor(
    private backend: EventBackend,
    private sessionId: () => string | undefined,
    private log?: (line: string) => void
  ) {}

  private sid(): string {
    const id = this.sessionId();
    if (!id) throw new Error('event store used before the session id exists');
    return id;
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const sid = this.sid();
    const seq = await this.backend.append(`${sid}~${streamId}`, message);
    const eventId = `${sid}~${streamId}~${seq}`;
    this.log?.(`event stored ${eventId} (${describe(message)})`);
    return eventId;
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    const parsed = parseEventId(eventId);
    if (parsed && parsed.sessionId === this.sessionId()) return parsed.streamId;
    // The id is not echoed: it came from the client.
    this.log?.('replay refused: the event id is not from this session');
    return undefined;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }
  ): Promise<string> {
    const parsed = parseEventId(lastEventId);
    if (!parsed || parsed.sessionId !== this.sessionId()) throw new Error('Invalid event ID');
    const { sessionId, streamId, seq } = parsed;
    this.log?.(`replay requested after ${lastEventId}`);
    const entries = await this.backend.after(`${sessionId}~${streamId}`, seq);
    // Sequence numbers have no holes, so a first event that is not the next one
    // means older events were dropped (cap or expiry). Say so rather than
    // quietly skipping messages. With no events at all, the counter decides:
    // a number above the client's means events existed and have expired.
    const dropped = entries.length > 0 ? entries[0].seq !== seq + 1 : (await this.backend.lastSeq(`${sessionId}~${streamId}`)) > seq;
    if (dropped) {
      this.log?.(`replay refused: events after ${lastEventId} are no longer stored`);
      throw new Error('Some events are no longer stored');
    }
    let sent = 0;
    for (const e of entries) {
      // The empty priming event only carries an id; it is never replayed.
      if (Object.keys(e.message).length === 0) continue;
      const eventId = `${sessionId}~${streamId}~${e.seq}`;
      await send(eventId, e.message);
      sent += 1;
      this.log?.(`replay sent ${eventId} (${describe(e.message)})`);
    }
    this.log?.(`replay done: ${sent} event(s) after ${lastEventId}`);
    return streamId;
  }
}
