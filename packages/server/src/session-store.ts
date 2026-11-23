// Stage 11.1: the part of an HTTP session that is plain data, kept apart from
// the live objects (McpServer, transport, open streams). Data can move to a
// shared store; live objects cannot, so another instance rebuilds them from the
// record (see test/session-rebuild.test.ts).
import type { SessionState } from './create-server.js';

export interface SessionRecord {
  id: string;
  /** The `sub` that opened the session (only when auth is on). */
  owner?: string;
  /** Per-session tool state, e.g. the home location. */
  state: SessionState;
  /** The client's `initialize` params, replayed to rebuild the session elsewhere. */
  initializeParams?: unknown;
  createdAt: number;
  lastSeen: number;
}

// Async on purpose: the Redis store (11.2) has to be.
export interface SessionStore {
  get(id: string): Promise<SessionRecord | undefined>;
  set(record: SessionRecord): Promise<void>;
  /** Mark the session as used now. A missing id is ignored. */
  touch(id: string, now?: number): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private records = new Map<string, SessionRecord>();

  async get(id: string) {
    return this.records.get(id);
  }
  async set(record: SessionRecord) {
    this.records.set(record.id, record);
  }
  async touch(id: string, now: number = Date.now()) {
    const record = this.records.get(id);
    if (record) record.lastSeen = now;
  }
  async delete(id: string) {
    this.records.delete(id);
  }
}

// The store could not be reached (Redis down). http.ts turns this into a 503
// with Retry-After, so a store outage does not look like a server bug.
export class StoreUnavailableError extends Error {
  constructor() {
    super('The session store is unavailable');
    this.name = 'StoreUnavailableError';
  }
}
