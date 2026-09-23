import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Server and client are separate packages (separate build/ output), so this
// path is resolved relative to this file's own location rather than assumed
// to be a sibling of whatever directory the command was run from.
const serverEntry = path.resolve(import.meta.dirname, '../../server/build/index.js');

// Shared by both the CLI script (client.ts) and the web dashboard
// (packages/web) — anything that needs to talk to the server goes through
// this one connection setup instead of duplicating it.
export async function connectToServer(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverEntry]
  });

  const client = new Client({
    name: 'mcp-demo-test-client',
    version: '0.1.0'
  });

  // connect() does the whole handshake: spawns the server, sends
  // "initialize", and waits for the server's reply.
  await client.connect(transport);
  return client;
}
