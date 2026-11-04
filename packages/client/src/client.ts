import { connectToServer } from './connection.js';

// This is a minimal custom MCP CLIENT — not part of the mcp-demo server.
// It exists to see the other half of the protocol: the side that connects to
// a running server and calls its tools, the same way Claude Desktop or the
// Inspector do — just as plain code instead of a UI. Start the server first
// (pnpm start:http).

async function main() {
  const client = await connectToServer();
  console.log('Connected to server.');

  // Ask the server what tools it has — this sends "tools/list".
  const { tools } = await client.listTools();
  console.log(
    'Tools available:',
    tools.map((t) => t.name)
  );

  // Actually call the "add" tool — this sends "tools/call".
  const addResult = await client.callTool({
    name: 'add',
    arguments: { a: 2, b: 3 }
  });
  console.log('Result of add(2, 3):', addResult.content);

  // "divide" works the same way to call — the interesting part is what
  // comes back when the input breaks its validation rule.
  const divideResult = await client.callTool({
    name: 'divide',
    arguments: { a: 10, b: 2 }
  });
  console.log('Result of divide(10, 2):', divideResult.content);

  // b: 0 breaks divide's .refine() rule. Note this call is NOT wrapped in
  // try/catch — a validation rejection is a normal, resolved result with
  // isError: true, not a thrown exception. callTool() only throws for
  // things like the connection itself failing.
  const rejectedResult = await client.callTool({
    name: 'divide',
    arguments: { a: 10, b: 0 }
  });
  console.log('Result of divide(10, 0):', rejectedResult.content);
  console.log('  -> isError:', rejectedResult.isError);

  // get_weather is Stage 3's real, async I/O tool — a genuine network call,
  // not just a computation. Berlin's coordinates, chosen arbitrarily.
  const weatherResult = await client.callTool({
    name: 'get_weather',
    arguments: { latitude: 52.52, longitude: 13.41 }
  });
  console.log('Result of get_weather(52.52, 13.41):', weatherResult.content);

  // get_weather_batch reports progress while it works. Passing `onprogress`
  // makes the SDK attach a progressToken to the call, which is what tells the
  // server to send notifications/progress. `resetTimeoutOnProgress` restarts
  // the request timeout on every update, so a long batch that keeps making
  // progress isn't killed by the 60s default.
  const batchResult = await client.callTool(
    {
      name: 'get_weather_batch',
      arguments: {
        locations: [
          { name: 'Berlin', latitude: 52.52, longitude: 13.41 },
          { name: 'London', latitude: 51.51, longitude: -0.13 },
          { name: 'Tokyo', latitude: 35.68, longitude: 139.69 }
        ]
      }
    },
    undefined,
    {
      onprogress: ({ progress, total, message }) => console.log(`  progress ${progress}/${total}: ${message}`),
      resetTimeoutOnProgress: true
    }
  );
  console.log('Result of get_weather_batch:', batchResult.content);

  await client.close();
}

main().catch((error) => {
  console.error('Client error:', error);
  process.exit(1);
});
