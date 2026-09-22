import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// The server is the thing an MCP client (like Claude Desktop, Claude Code,
// or the MCP Inspector) connects to. Giving it a name/version is how it
// identifies itself during the initial handshake.
const server = new McpServer({
  name: 'mcp-demo',
  version: '0.1.0'
});

// A "tool" is a function we expose to the client. The client can ask what
// tools exist, see this description and inputSchema, and then call it with
// arguments that match the schema.
server.registerTool(
  'add',
  {
    title: 'Add two numbers',
    description: 'Adds two numbers together and returns their sum.',
    inputSchema: {
      a: z.number().describe('The first number'),
      b: z.number().describe('The second number')
    }
  },
  async ({ a, b }) => {
    console.error(`[mcp-demo] add called with a=${a}, b=${b}`);
    return {
      content: [
        {
          type: 'text',
          text: `${a + b}`
        }
      ]
    };
  }
);

// Stage 2's tool. "add" only needed zod to describe a *shape* (two numbers) —
// any two numbers are valid. "divide" needs a *rule*: b can be any number
// except zero. That's the difference between typing and validation — the
// schema itself now rejects a bad call before our handler ever runs.
server.registerTool(
  'divide',
  {
    title: 'Divide two numbers',
    description: 'Divides a by b and returns the quotient. Rejects division by zero.',
    inputSchema: {
      a: z.number().describe('The numerator'),
      b: z
        .number()
        .refine((value) => value !== 0, {
          message: 'b must not be zero — division by zero is undefined'
        })
        .describe('The denominator (must not be zero)')
    }
  },
  async ({ a, b }) => {
    console.error(`[mcp-demo] divide called with a=${a}, b=${b}`);
    return {
      content: [
        {
          type: 'text',
          text: `${a / b}`
        }
      ]
    };
  }
);

async function main() {
  // stdio means the client talks to us over this process's stdin/stdout,
  // rather than over a network port. It's the simplest way to run an MCP
  // server locally, since the client just launches the process directly.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mcp-demo server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error while starting server:', error);
  process.exit(1);
});
