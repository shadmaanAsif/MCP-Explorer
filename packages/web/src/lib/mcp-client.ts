import 'server-only';
import { connectToServer } from '@mcp-explorer/client';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// Caches the in-flight *promise*, not just the resolved client, on
// globalThis rather than a module-level variable: caching only the resolved
// value would let two racing requests each open their own connection, and a
// plain module variable resets on every Next.js dev-mode Fast Refresh reload
// while globalThis survives it. The server URL comes from MCP_SERVER_URL.
const globalForMcp = globalThis as unknown as { mcpClientPromise?: Promise<Client> };

export function getClient(): Promise<Client> {
  if (!globalForMcp.mcpClientPromise) {
    globalForMcp.mcpClientPromise = connectToServer(process.env.MCP_SERVER_URL);
  }
  return globalForMcp.mcpClientPromise;
}
