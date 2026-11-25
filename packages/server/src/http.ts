import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Hono, type Context } from 'hono';
import { bearerAuth, type AuthInfo } from './auth/middleware.js';
import { scopeGuard } from './auth/scopes.js';
import { resourceMetadataApp } from './auth/resource-metadata.js';
import { auditToStderr } from './audit.js';
import { createServer, type SessionState } from './create-server.js';
import { getConnInfo } from '@hono/node-server/conninfo';
import { loadConfigOrExit, MCP_PATH } from './config.js';
import { originGuard, rateLimit, sizeLimit } from './http-guards.js';
import { Redis } from 'ioredis';
import { MemorySessionStore, StoreUnavailableError, type SessionRecord, type SessionStore } from './session-store.js';
import { RedisSessionStore } from './session-store-redis.js';
import {
  MemoryEventBackend,
  RedisEventBackend,
  ScopedEventStore,
  type EventBackend
} from './event-store.js';
import { adoptStoredState, replayInitialize } from './session-rebuild.js';
import { configureLog, log, newRequestId, runWithContext, setContext } from './log.js';

// Stage 10.5: every setting is read and checked once, in config.ts. A bad value
// stops the server here with a message that names the variable.
const config = loadConfigOrExit();
// Stage 12.1: from here on every line goes through the logger, in the chosen format.
configureLog({ format: config.logFormat, level: config.logLevel, instance: config.instanceId });
const PORT = config.port;
const MCP_SERVER_URL = config.mcpServerUrl;
const ISSUER_URL = config.issuerUrl;
const SESSION_HEADER = 'mcp-session-id';
const SESSION_TTL_MS = config.sessionTtlMs;
const SWEEP_INTERVAL_MS = Math.min(60_000, SESSION_TTL_MS);

// stateful (default): one McpServer + transport per client session, found again
// on later requests through the Mcp-Session-Id header.
// stateless: a fresh McpServer + transport per request, nothing remembered.
const MODE = config.mode;

// Hono hands us a web-standard Request and expects a Response back, so the
// MCP side uses the SDK's web-standard transport (the Node transport is a
// wrapper around it).
function jsonRpcError(c: Context, status: 400 | 403 | 404 | 500, code: number, message: string) {
  return c.json({ jsonrpc: '2.0', error: { code, message }, id: null }, status);
}

// Runs `done` once the response body has been fully sent or the client went
// away. Replaces `res.on('close')` from the node:http version: with a
// web-standard Response there is no socket to listen on, only the stream.
function afterBody(response: Response, done: () => void | Promise<void>): Response {
  if (!response.body) {
    done();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = async () => {
    if (!finished) {
      finished = true;
      await done();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read();
        if (end) {
          // Wait for `done` first: the client only sees the end of the answer
          // after, for example, the changed state has reached the store.
          await finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        void finish();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        void finish();
      }
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// ---- stateless ----------------------------------------------------------

// Every POST gets its own McpServer + transport (sessionIdGenerator:
// undefined), so there is no session to track and the process can be
// restarted or scaled freely. GET (server-initiated stream) and DELETE (end
// session) only make sense with sessions.
async function handleStateless(c: Context) {
  if (c.req.method !== 'POST') {
    return c.body(null, 405, { Allow: 'POST' });
  }
  const body = await c.req.json();
  const server = createServer({}, auditToStderr);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const response = await transport.handleRequest(c.req.raw, { parsedBody: body, authInfo: authInfoOf(c) });
  return afterBody(response, () => {
    void transport.close();
    void server.close();
  });
}

// ---- stateful -----------------------------------------------------------

// Live objects only. The data (owner, state, last seen) is in the SessionStore.
// `state` is the object the tools change; `savedState` is its JSON as last
// written to the store, so we only write when it changed.
type Session = {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  state: SessionState;
  savedState: string;
};

// Stage 11: the data half of every session. Memory by default (one process, as
// before); SESSION_STORE=redis shares it between instances and across restarts.
let redisClient: Redis | undefined;
async function makeStore(): Promise<SessionStore> {
  if (config.sessionStore !== 'redis') return new MemorySessionStore();
  // Fail fast on a command when Redis is down, so a request gets a 503 instead
  // of waiting in a queue. Error messages are not printed: they can hold the URL.
  const redis = new Redis(config.redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  let lastWarn = 0;
  redis.on('error', () => {
    if (Date.now() - lastWarn > 10_000) {
      lastWarn = Date.now();
      log.warn('session store (Redis) connection problem');
    }
  });
  try {
    await redis.connect();
    await redis.ping();
  } catch {
    log.error('Cannot reach Redis (SESSION_STORE=redis). Check REDIS_URL and that Redis is running.', { bare: true });
    process.exit(1);
  }
  redisClient = redis;
  return new RedisSessionStore(redis, SESSION_TTL_MS);
}
const store: SessionStore = await makeStore();

// Stage 11.3: the events behind resumable streams. Off by default, because it
// makes the server send priming events that older behaviour never had. They
// live in Redis when sessions do, so any instance can replay a stream.
const eventBackend: EventBackend | undefined = !config.resumableStreams
  ? undefined
  : redisClient
    ? new RedisEventBackend(redisClient, { maxEvents: config.eventMaxPerStream, ttlMs: config.eventTtlMs })
    : new MemoryEventBackend({ maxEvents: config.eventMaxPerStream, ttlMs: config.eventTtlMs });
// On shutdown the live objects close, but the records stay: that is what lets
// another instance (or this one after a restart) take the sessions over.
let shuttingDown = false;

// The caller bearerAuth verified, or undefined when auth is off.
const callerOf = (c: Context) => (c as Context<{ Variables: { auth?: AuthInfo } }>).get('auth')?.subject;

// What the tool handlers see as `extra.authInfo`, so the audit log knows who called.
// The token itself is not passed on.
const authInfoOf = (c: Context) => {
  const auth = (c as Context<{ Variables: { auth?: AuthInfo } }>).get('auth');
  return auth ? { token: '', clientId: auth.subject, scopes: auth.scopes } : undefined;
};

const sessions = new Map<string, Session>();

async function buildSession(opts: {
  owner?: string;
  initializeParams: unknown;
  /** Set when rebuilding from the store: same id, same state, no new record. */
  restore?: SessionRecord;
}): Promise<Session> {
  const { restore } = opts;
  const state: SessionState = restore ? structuredClone(restore.state) : {};
  const server = createServer(state, auditToStderr);
  // The event store needs this session's id, which exists only after the
  // transport has handled initialize, so it reads it from the transport later.
  let transportRef: WebStandardStreamableHTTPServerTransport | undefined;
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: restore ? () => restore.id : randomUUID,
    eventStore: eventBackend
      ? new ScopedEventStore(
          eventBackend,
          () => transportRef?.sessionId,
          config.eventDebug ? (line) => log.info(line) : undefined
        )
      : undefined,
    // The id only exists once the initialize request is handled, so the
    // session is registered here, not before handleRequest.
    onsessioninitialized: async (id) => {
      if (restore) return; // the record exists already; rebuildSession registers the session
      const now = Date.now();
      await store.set({ id, owner: opts.owner, state, initializeParams: opts.initializeParams, createdAt: now, lastSeen: now });
      sessions.set(id, session);
      log.info(`session ${id} opened (${sessions.size} active)`, { session: id });
    }
  });
  transportRef = transport;
  const session: Session = { server, transport, state, savedState: JSON.stringify(state) };
  transport.onclose = () => {
    const id = transport.sessionId;
    // Only the session that is registered under this id may remove it, so a
    // stale closed object cannot delete a rebuilt one's entry.
    if (id && sessions.get(id) === session) {
      sessions.delete(id);
      if (!shuttingDown) store.delete(id).catch(() => {});
      log.info(`session ${id} closed (${sessions.size} active)`, { session: id });
    }
  };
  await server.connect(transport);
  return session;
}

const createSession = (owner: string | undefined, initializeParams: unknown) => buildSession({ owner, initializeParams });

// A store hit with no live session here: another instance made it, or this one
// restarted. Build new live objects from the record. Concurrent requests for the
// same id share one rebuild.
const rebuilding = new Map<string, Promise<Session>>();
function rebuildSession(record: SessionRecord): Promise<Session> {
  let pending = rebuilding.get(record.id);
  if (!pending) {
    pending = (async () => {
      const session = await buildSession({ owner: record.owner, initializeParams: record.initializeParams, restore: record });
      try {
        await replayInitialize(session.transport, record.id, record.initializeParams);
      } catch (error) {
        void session.transport.close();
        throw error;
      }
      sessions.set(record.id, session);
      log.info(`session ${record.id} rebuilt from the store (${sessions.size} active)`, { session: record.id });
      return session;
    })().finally(() => rebuilding.delete(record.id));
    rebuilding.set(record.id, pending);
  }
  return pending;
}

// Tools change `state` (set_home_location). Redis holds a copy, so a change has
// to be written back or another instance would restore the old value.
async function persistState(id: string, session: Session) {
  const json = JSON.stringify(session.state);
  if (json === session.savedState) return;
  try {
    const record = await store.get(id);
    if (!record) return;
    await store.set({ ...record, state: session.state });
    session.savedState = json;
  } catch (error) {
    log.warn(`could not save state for session ${id}: ${error instanceof Error ? error.message : error}`, { session: id });
  }
}

async function handleStateful(c: Context) {
  const sessionId = c.req.header(SESSION_HEADER);

  if (sessionId) {
    setContext({ session: sessionId });
    let session = sessions.get(sessionId);
    const record = await store.get(sessionId);
    if (!record) {
      // The record expired or never existed. A live object held for it is stale.
      if (session) void session.transport.close();
      // Spec: an unknown/expired id is 404, which tells the client to start
      // over with a new initialize.
      return jsonRpcError(c, 404, -32001, 'Session not found');
    }
    // A session belongs to the caller that opened it: another valid token
    // must not be able to ride on it. Checked before any rebuild.
    if (record.owner !== undefined && record.owner !== callerOf(c)) {
      return jsonRpcError(c, 403, -32000, 'This session belongs to another caller');
    }
    if (!session) {
      if (record.initializeParams === undefined) return jsonRpcError(c, 404, -32001, 'Session not found');
      session = await rebuildSession(record);
    } else if (adoptStoredState(session, record.state)) {
      // Another instance saved a newer state since this one last loaded it.
      log.info(`session ${sessionId} state refreshed from the store`);
    }
    await store.touch(sessionId);
    // POST (requests), GET (server → client stream), DELETE (end session)
    // are all handled by the session's own transport.
    const body = c.req.method === 'POST' ? await c.req.json() : undefined;
    const response = await session.transport.handleRequest(c.req.raw, { parsedBody: body, authInfo: authInfoOf(c) });
    // After a POST finishes, save any state a tool changed.
    const live = session;
    return c.req.method === 'POST' ? afterBody(response, () => persistState(sessionId, live)) : response;
  }

  // No session id: the only valid request is a POST that opens a session.
  if (c.req.method !== 'POST') {
    return jsonRpcError(c, 400, -32000, 'Mcp-Session-Id header is required');
  }
  const body = await c.req.json();
  if (!isInitializeRequest(body)) {
    return jsonRpcError(c, 400, -32000, 'Missing Mcp-Session-Id: send an initialize request first');
  }
  const session = await createSession(callerOf(c), (body as { params?: unknown }).params);
  const response = await session.transport.handleRequest(c.req.raw, { parsedBody: body, authInfo: authInfoOf(c) });
  // The id exists only now; the request line logged after this carries it.
  setContext({ session: session.transport.sessionId });
  return response;
}

// Clients that vanish without sending DELETE would otherwise leak sessions.
async function sweepIdleSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    const record = await store.get(id);
    // No record: it expired in the store (Redis key expiry), so close the live object.
    if (!record || record.lastSeen < cutoff) {
      log.info(`session ${id} idle for over ${SESSION_TTL_MS}ms, closing`, { session: id });
      void session.transport.close();
    }
  }
}

// ---- app ----------------------------------------------------------------

const app = new Hono();

// Middleware runs for every request, in order. Later stages add auth (Stage 9),
// Origin checks and rate limits (Stage 10) and tracing (Stage 12) here.
// Stage 12.1: it also opens the request context, so every line written while this
// request runs carries the same `req` (and the session and caller, once known).
app.use('*', (c, next) =>
  runWithContext({ req: newRequestId() }, async () => {
    const start = Date.now();
    await next();
    log.info(`${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - start}ms`);
  })
);

// Public: a client reads this before it has a token (Stage 9.2).
app.route('/', resourceMetadataApp(MCP_SERVER_URL, ISSUER_URL));
// Stage 10.2: always on (not behind AUTH_REQUIRED). A foreign Origin is refused
// before any token check, so a browser page cannot even probe the server.
app.use(MCP_PATH, originGuard(config.allowedOrigins));
// Stage 10.3: a body over MAX_BODY_BYTES gets 413 before anything reads it.
app.use(MCP_PATH, sizeLimit(config.maxBodyBytes));
// Stage 9.3: with AUTH_REQUIRED=1 every /mcp request needs a valid Bearer token.
// Off by default until the CLI client and dashboard can send one (9.4).
if (config.authRequired) {
  app.use(
    MCP_PATH,
    bearerAuth({
      issuer: ISSUER_URL,
      audience: MCP_SERVER_URL,
      resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource/mcp', MCP_SERVER_URL).href,
      scope: config.authScope,
    }),
  );
  // Stage 10.1: a valid token is not enough; each tool needs its own scope.
  app.use(MCP_PATH, scopeGuard(new URL('/.well-known/oauth-protected-resource/mcp', MCP_SERVER_URL).href, auditToStderr));
}
// Stage 10.3: after the auth guards, so the caller is the token's `sub`; with auth
// off it is the client address. RATE_LIMIT_PER_MINUTE=0 turns the limit off.
const RATE_PER_MINUTE = config.ratePerMinute;
if (RATE_PER_MINUTE > 0) {
  app.use(
    MCP_PATH,
    rateLimit(RATE_PER_MINUTE, (c) => {
      const auth = c.get('auth' as never) as { subject?: string } | undefined;
      return auth?.subject ? `sub:${auth.subject}` : `ip:${getConnInfo(c).remote.address ?? 'unknown'}`;
    })
  );
}
app.all(MCP_PATH, (c) => (MODE === 'stateful' ? handleStateful(c) : handleStateless(c)));
app.notFound((c) => c.body(null, 404));
app.onError((error, c) => {
  if (error instanceof StoreUnavailableError) {
    return c.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Session store unavailable, retry shortly' }, id: null }, 503, {
      'Retry-After': '5'
    });
  }
  log.error('error handling request:', { err: error });
  return jsonRpcError(c, 500, -32603, 'Internal server error');
});

// ---- entry --------------------------------------------------------------

// The review tools read this machine's disk, so over HTTP they refuse unless an
// admin opts in (REVIEW_ALLOW_HTTP=1). When allowed, a shared server also has
// no meaningful start folder, so a call must name its project; set
// REVIEW_REQUIRE_ROOT=0 to allow the fallback.
process.env.REVIEW_TRANSPORT = 'http';
process.env.REVIEW_REQUIRE_ROOT ??= '1';

const httpServer = serve({ fetch: app.fetch, port: PORT }, () => {
  log.info(`mcp-demo server running on http://localhost:${PORT}${MCP_PATH} (${MODE})`, { bare: true });
});

let sweeper: NodeJS.Timeout | undefined;
if (MODE === 'stateful') {
  sweeper = setInterval(() => {
    sweepIdleSessions().catch((err) => log.error('idle sweep failed:', { err }));
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
}

async function shutdown() {
  shuttingDown = true;
  if (sweeper) clearInterval(sweeper);
  httpServer.close();
  await Promise.all([...sessions.values()].map((s) => s.transport.close()));
  await redisClient?.quit().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
