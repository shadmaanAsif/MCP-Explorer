import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './create-server.js';
import { configureLog, log, logSettingsFromEnv } from './log.js';

async function main() {
  // stdio means the client talks to us over this process's stdin/stdout,
  // rather than over a network port. It's the simplest way to run an MCP
  // server locally, since the client just launches the process directly.
  configureLog(logSettingsFromEnv());
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('mcp-demo server running on stdio', { bare: true });
}

main().catch((error) => {
  log.error('Fatal error while starting server:', { err: error, bare: true });
  process.exit(1);
});
