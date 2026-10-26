import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_SERVER_URL = 'http://localhost:4768/mcp';

// Shared by both the CLI script (client.ts) and the web dashboard
// (packages/web) — anything that needs to talk to the server goes through
// this one connection setup instead of duplicating it.
//
// The server runs as its own process (pnpm start:http)
// and is reached over HTTP, so the client no longer spawns it or needs to
// know where its build output lives — just a URL.
export async function connectToServer(
  url: string = process.env.MCP_SERVER_URL ?? DEFAULT_SERVER_URL
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url));

  const client = new Client({
    name: 'mcp-demo-test-client',
    version: '0.1.0'
  });

  // connect() does the whole handshake: sends "initialize" to the server's
  // URL and waits for its reply.
  await client.connect(transport);
  return client;
}
