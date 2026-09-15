# MCP architecture reference

Condensed technical facts established while building this project. The narrative explanations (with analogies, diagrams, worked examples) live in the README and the published artifact — this file is the quick-reference version for when you're actually writing code, not learning the concept for the first time.

## The mental models

- **Server:** server → tool → transport. `new McpServer({ name, version })`, `server.registerTool(name, { title, description, inputSchema }, handler)`, `await server.connect(transport)`.
- **Client:** transport → client → connect → discover → call → close. `new StdioClientTransport({ command, args })`, `new Client({ name, version })`, `await client.connect(transport)`, `await client.listTools()`, `await client.callTool({ name, arguments })`, `await client.close()`.
- **The client always spawns the server, never the reverse.** True for the Inspector, the custom client in `src/client.ts`, and every real client (Claude Desktop, Claude.ai connectors, ChatGPT connectors).

## Transport

- **Local (what this project uses today): `stdio`.** The client spawns the server as a child process and talks over its stdin/stdout. No auth — the spec says stdio servers shouldn't implement it; trust is implicit, since you're running your own code as yourself.
- **Production (reference only — see the artifact's "Production" sub-tab, nothing built yet): Streamable HTTP.** One HTTP endpoint handling `POST`/`GET`/`DELETE`. Stateless mode is available via `sessionIdGenerator: undefined` on `StreamableHTTPServerTransport` — already present in the `@modelcontextprotocol/sdk` version installed here, no new dependency needed to try it.

## Logging inside a stdio server

Always `console.error`, never `console.log`. stdout is the JSON-RPC channel; anything else printed there corrupts the protocol stream.

## Two instances, not one

Every client connection spawns its own fresh server process. `npm start` running in a terminal and an Inspector/client connection are two separate, unrelated instances of the same code — they share no state, and nothing sent to one shows up in the other.
