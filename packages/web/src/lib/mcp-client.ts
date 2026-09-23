import 'server-only';
import { connectToServer } from '@mcp-explorer/client';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// Caches the in-flight *promise*, not just the resolved client, on
// globalThis rather than a module-level variable: connectToServer() spawns
// a server subprocess, so caching only the resolved value would let two
// racing requests spawn two subprocesses, and a plain module variable
// resets on every Next.js dev-mode Fast Refresh reload while globalThis
// survives it.
const globalForMcp = globalThis as unknown as { mcpClientPromise?: Promise<Client> };

export function getClient(): Promise<Client> {
  if (!globalForMcp.mcpClientPromise) {
    globalForMcp.mcpClientPromise = connectToServer();
  }
  return globalForMcp.mcpClientPromise;
}
