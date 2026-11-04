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

// Drops the cached client so the next getClient() connects again. Needed when
// the server restarts: its session map is empty, so the session id this
// client holds gets a 404 on every call from then on.
function resetClient(): void {
  globalForMcp.mcpClientPromise = undefined;
}

// Runs fn with the shared client. A 404 means the server no longer knows our
// session id (it restarted), so connect again, which starts a new session, and
// retry once. Any other error, or a second 404, is a real failure and propagates.
export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  try {
    const client = await getClient();
    const result = await fn(client);
    return result;
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;
    resetClient();
    const freshClient = await getClient();
    const retryResult = await fn(freshClient);
    return retryResult;
  }
}
