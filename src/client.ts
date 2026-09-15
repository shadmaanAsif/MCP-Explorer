import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// This is a minimal custom MCP CLIENT — not part of the mcp-demo server.
// It exists to see the other half of the protocol: the side that spawns a
// server, connects to it, and calls its tools, the same way Claude Desktop
// or the Inspector do — just as plain code instead of a UI.

async function main() {
  // The client is the one that spawns the server as its own child process
  // and talks to it over that process's stdin/stdout — same relationship
  // the Inspector has with the server, just written out by hand here.
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['build/index.js']
  });

  const client = new Client({
    name: 'mcp-demo-test-client',
    version: '0.1.0'
  });

  // connect() does the whole handshake for you: it spawns the server,
  // sends "initialize", and waits for the server's reply.
  await client.connect(transport);
  console.log('Connected to server.');

  // Ask the server what tools it has — this sends "tools/list".
  const { tools } = await client.listTools();
  console.log(
    'Tools available:',
    tools.map((t) => t.name)
  );

  // Actually call the "add" tool — this sends "tools/call".
  const result = await client.callTool({
    name: 'add',
    arguments: { a: 2, b: 3 }
  });
  console.log('Result of add(2, 3):', result.content);

  await client.close();
}

main().catch((error) => {
  console.error('Client error:', error);
  process.exit(1);
});
