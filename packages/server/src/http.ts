import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string) {
  if (res.headersSent) return;
  res
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

// ---- stateless ----------------------------------------------------------

// Every POST gets its own McpServer + transport (sessionIdGenerator:
// undefined), so there is no session to track and the process can be
// restarted or scaled freely. GET (server-initiated stream) and DELETE (end
// session) only make sense with sessions.
async function handleStateless(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  const body = await readJson(req);
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ---- stateful -----------------------------------------------------------

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  state: SessionState;
  lastSeen: number;
};

const sessions = new Map<string, Session>();

async function createSession(): Promise<Session> {
  const state: SessionState = {};
  const server = createServer(state);
  const transport = new StreamableHTTPServerTransport({
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

async function handleStateful(req: IncomingMessage, res: ServerResponse) {

  const header = req.headers[SESSION_HEADER];
  const sessionId = Array.isArray(header) ? header[0] : header;

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      // Spec: an unknown/expired id is 404, which tells the client to start
      // over with a new initialize.
      sendJsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    session.lastSeen = Date.now();
    // POST (requests), GET (server → client stream), DELETE (end session)
    // are all handled by the session's own transport.
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    // console.log('body111', body)
    await session.transport.handleRequest(req, res, body);
    return;
  }

  // No session id: the only valid request is a POST that opens a session.
  if (req.method !== 'POST') {
    sendJsonRpcError(res, 400, -32000, 'Mcp-Session-Id header is required');
    return;
  }
  const body = await readJson(req);
  if (!isInitializeRequest(body)) {
    sendJsonRpcError(res, 400, -32000, 'Missing Mcp-Session-Id: send an initialize request first');
    return;
  }
  const session = await createSession();
  await session.transport.handleRequest(req, res, body);
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

// ---- entry --------------------------------------------------------------

const httpServer = createHttpServer(async (req, res) => {
  if (req.url !== MCP_PATH) {
    res.writeHead(404).end();
    return;
  }
  try {
    await (MODE === 'stateful' ? handleStateful(req, res) : handleStateless(req, res));
  } catch (error) {
    console.error('[mcp-demo] error handling request:', error);
    sendJsonRpcError(res, 500, -32603, 'Internal server error');
  }
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

httpServer.listen(PORT, () => {
  // Safe to use console.log here, unlike the stdio entry: stdout isn't the
  // protocol channel over HTTP. console.error kept for consistency.
  console.error(`mcp-demo server running on http://localhost:${PORT}${MCP_PATH} (${MODE})`);
});
