import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Shared by both the CLI script (client.ts) and the web dashboard
// (packages/web) — anything that needs to talk to the server goes through
// this one connection setup instead of duplicating it.
export async function connectToServer(): Promise<Client> {
  // Server and client are separate packages (separate build/ output), so
  // this path is resolved relative to this file's own location rather than
  // assumed to be a sibling of whatever directory the command was run from.
  // Resolved lazily, inside the function, rather than at module load time:
  // a bundler (e.g. Next.js's build-time page-data collection) can import
  // this module without calling connectToServer(), and some of those import
  // contexts don't populate import.meta.dirname — a module-level const
  // would crash on import alone. fileURLToPath(import.meta.url) is used
  // instead of import.meta.dirname directly for the same reason: Turbopack's
  // externalized-module loader (via serverExternalPackages) doesn't
  // populate the dirname shorthand, but does preserve import.meta.url.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverEntry = path.resolve(here, '../../server/build/index.js');

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
