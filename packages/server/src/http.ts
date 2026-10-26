import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './create-server.js';

const PORT = Number(process.env.PORT ?? 4768);
const MCP_PATH = '/mcp';

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Stateless Streamable HTTP: every POST gets its own McpServer + transport
// (sessionIdGenerator: undefined), so there is no session to track and the
// process can be restarted or scaled freely. stdio's "one process per
// client" becomes "one server instance per request".
const httpServer = createHttpServer(async (req, res) => {
  if (req.url !== MCP_PATH) {
    res.writeHead(404).end();
    return;
  }
  // GET (server-initiated SSE stream) and DELETE (end session) only make
  // sense with sessions, which stateless mode doesn't have.
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }

  try {
    const body = await readJson(req);
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error('[mcp-demo] error handling request:', error);
    if (!res.headersSent) {
      res
        .writeHead(500, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    }
  }
});

httpServer.listen(PORT, () => {
  // Safe to use console.log here, unlike the stdio entry: stdout isn't the
  // protocol channel over HTTP. console.error kept for consistency.
  console.error(`mcp-demo server running on http://localhost:${PORT}${MCP_PATH}`);
});
