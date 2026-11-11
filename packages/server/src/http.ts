import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Hono, type Context } from 'hono';
import { createServer, type SessionState } from './create-server.js';

const PORT = Number(process.env.PORT ?? 4768);
const MCP_PATH = '/mcp';
const SESSION_HEADER = 'mcp-session-id';
const SESSION_TTL_MS = Number(process.env.MCP_SESSION_TTL_MS ?? 30 * 60 * 1000);
const SWEEP_INTERVAL_MS = Math.min(60_000, SESSION_TTL_MS);

// stateful (default): one McpServer + transport per client session, found again
// on later requests through the Mcp-Session-Id header.
// stateless: a fresh McpServer + transport per request, nothing remembered.
const MODE = process.env.MCP_MODE === 'stateless' ? 'stateless' : 'stateful';

// Hono hands us a web-standard Request and expects a Response back, so the
// MCP side uses the SDK's web-standard transport (the Node transport is a
// wrapper around it).
function jsonRpcError(c: Context, status: 400 | 404 | 500, code: number, message: string) {
  return c.json({ jsonrpc: '2.0', error: { code, message }, id: null }, status);
}

// Runs `done` once the response body has been fully sent or the client went
// away. Replaces `res.on('close')` from the node:http version: with a
// web-standard Response there is no socket to listen on, only the stream.
function afterBody(response: Response, done: () => void): Response {
  if (!response.body) {
    done();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      done();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read();
        if (end) {
          controller.close();
          finish();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
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
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const response = await transport.handleRequest(c.req.raw, { parsedBody: body });
  return afterBody(response, () => {
    void transport.close();
    void server.close();
  });
}

// ---- stateful -----------------------------------------------------------

type Session = {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  state: SessionState;
  lastSeen: number;
};

const sessions = new Map<string, Session>();

async function createSession(): Promise<Session> {
  const state: SessionState = {};
  const server = createServer(state);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    // The id only exists once the initialize request is handled, so the
    // session is registered here, not before handleRequest.
    onsessioninitialized: (id) => {
      sessions.set(id, session);
      console.error(`[mcp-demo] session ${id} opened (${sessions.size} active)`);
    }
  });
  const session: Session = { server, transport, state, lastSeen: Date.now() };
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id && sessions.delete(id)) console.error(`[mcp-demo] session ${id} closed (${sessions.size} active)`);
  };
  await server.connect(transport);
  return session;
}

async function handleStateful(c: Context) {
  const sessionId = c.req.header(SESSION_HEADER);

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      // Spec: an unknown/expired id is 404, which tells the client to start
      // over with a new initialize.
      return jsonRpcError(c, 404, -32001, 'Session not found');
    }
    session.lastSeen = Date.now();
    // POST (requests), GET (server → client stream), DELETE (end session)
    // are all handled by the session's own transport.
    const body = c.req.method === 'POST' ? await c.req.json() : undefined;
    return session.transport.handleRequest(c.req.raw, { parsedBody: body });
  }

  // No session id: the only valid request is a POST that opens a session.
  if (c.req.method !== 'POST') {
    return jsonRpcError(c, 400, -32000, 'Mcp-Session-Id header is required');
  }
  const body = await c.req.json();
  if (!isInitializeRequest(body)) {
    return jsonRpcError(c, 400, -32000, 'Missing Mcp-Session-Id: send an initialize request first');
  }
  const session = await createSession();
  return session.transport.handleRequest(c.req.raw, { parsedBody: body });
}

// Clients that vanish without sending DELETE would otherwise leak sessions.
function sweepIdleSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) {
      console.error(`[mcp-demo] session ${id} idle for over ${SESSION_TTL_MS}ms, closing`);
      void session.transport.close();
    }
  }
}

// ---- app ----------------------------------------------------------------

const app = new Hono();

// Middleware runs for every request, in order. Later stages add auth (Stage 9),
// Origin checks and rate limits (Stage 10) and tracing (Stage 12) here.
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  console.error(`[mcp-demo] ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - start}ms`);
});

app.all(MCP_PATH, (c) => (MODE === 'stateful' ? handleStateful(c) : handleStateless(c)));
app.notFound((c) => c.body(null, 404));
app.onError((error, c) => {
  console.error('[mcp-demo] error handling request:', error);
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
  // Safe to use console.log here, unlike the stdio entry: stdout isn't the
  // protocol channel over HTTP. console.error kept for consistency.
  console.error(`mcp-demo server running on http://localhost:${PORT}${MCP_PATH} (${MODE})`);
});

let sweeper: NodeJS.Timeout | undefined;
if (MODE === 'stateful') {
  sweeper = setInterval(sweepIdleSessions, SWEEP_INTERVAL_MS);
  sweeper.unref();
}

async function shutdown() {
  if (sweeper) clearInterval(sweeper);
  httpServer.close();
  await Promise.all([...sessions.values()].map((s) => s.transport.close()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
