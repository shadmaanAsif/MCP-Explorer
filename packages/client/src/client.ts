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

  // --- Resources: read-only data addressed by URI -------------------------
  // The client asks what exists, then reads one by URI. Nothing is executed.
  const { resources } = await client.listResources();
  console.log(
    'Resources:',
    resources.map((r) => r.uri)
  );
  const { resourceTemplates } = await client.listResourceTemplates();
  console.log(
    'Resource templates:',
    resourceTemplates.map((t) => t.uriTemplate)
  );
  const dubai = await client.readResource({ uri: 'weather://city/dubai' });
  // Contents are either text or a binary blob, so check which one came back.
  const first = dubai.contents[0];
  console.log('Read weather://city/dubai:', first && 'text' in first ? first.text : first);

  // --- Prompts: ready-made requests the user picks ------------------------
  // getPrompt returns messages. A real AI client would send them to its
  // model; this CLI has no model, so it only prints them.
  const { prompts } = await client.listPrompts();
  console.log(
    'Prompts:',
    prompts.map((p) => p.name)
  );
  const prompt = await client.getPrompt({
    name: 'compare_weather',
    arguments: { cityA: 'dubai', cityB: 'delhi' }
  });
  console.log('compare_weather ->', prompt.messages[0]?.content);

  // --- Completions: autocomplete for prompt/resource arguments ------------
  const promptCompletion = await client.complete({
    ref: { type: 'ref/prompt', name: 'compare_weather' },
    argument: { name: 'cityA', value: 'd' }
  });
  console.log("Completions for cityA='d':", promptCompletion.completion.values);
  const resourceCompletion = await client.complete({
    ref: { type: 'ref/resource', uri: 'weather://city/{name}' },
    argument: { name: 'name', value: 'n' }
  });
  console.log("Completions for weather://city/{name} 'n':", resourceCompletion.completion.values);

  // Unlike a tool's isError result, a bad resource or prompt request is a
  // protocol error, so it is thrown and needs a try/catch.
  try {
    await client.readResource({ uri: 'weather://city/atlantis' });
  } catch (error) {
    console.log('Read weather://city/atlantis failed:', (error as Error).message);
  }

  await client.close();
}

main().catch((error) => {
  console.error('Client error:', error);
  process.exit(1);
});
