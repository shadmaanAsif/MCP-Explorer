import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './create-server.js';

async function main() {
  // stdio means the client talks to us over this process's stdin/stdout,
  // rather than over a network port. It's the simplest way to run an MCP
  // server locally, since the client just launches the process directly.
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mcp-demo server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error while starting server:', error);
  process.exit(1);
});
