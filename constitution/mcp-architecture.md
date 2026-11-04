# MCP architecture reference

Condensed technical facts established while building this project. The narrative explanations (with analogies, diagrams, worked examples) live in the README and the published artifact — this file is the quick-reference version for when you're actually writing code, not learning the concept for the first time.

## The mental models

- **Server:** server → tool → transport. `new McpServer({ name, version })`, `server.registerTool(name, { title, description, inputSchema }, handler)`, `await server.connect(transport)`.
- **Client:** transport → client → connect → discover → call → close. `new StreamableHTTPClientTransport(new URL(url))` (or `new StdioClientTransport({ command, args })` to spawn a stdio server), `new Client({ name, version })`, `await client.connect(transport)`, `await client.listTools()`, `await client.callTool({ name, arguments })`, `await client.close()`.
- **Over stdio, the client spawns the server, never the reverse.** True for the Inspector, Cursor and Claude Desktop. Over Streamable HTTP the server is a standalone process and the client just connects to its URL — which is how `packages/client` and `packages/web` use it since `08-server-http-transport`.

## Monorepo layout (since `06-monorepo-server-client-split`)

- Server and client are separate pnpm-workspace packages (`packages/server`, `packages/client`), each with its own `package.json`/dependencies/`build/` output. `pnpm-workspace.yaml` declares the workspace; the root `package.json` pins pnpm and forwards scripts via `pnpm --filter`. pnpm is strict about undeclared imports, so each package must list every dependency it imports.
- Because the client's `build/` is no longer a sibling of the server's, the stdio client resolved the server's entry point relative to its own file, not the current working directory. That's gone since `08-server-http-transport`: the client connects by URL and no longer knows where the server's build output is.
- External stdio connections (Claude Desktop, Cursor, etc.) point at `packages/server/build/index.js`, not `build/index.js`.
- The server's tools live in `packages/server/src/create-server.ts` (`createServer()` factory); `index.ts` is the stdio entry, `http.ts` the Streamable HTTP entry. One server definition, two transports.

## Transport

- **stdio** (`packages/server/src/index.ts`): the client spawns the server as a child process and talks over its stdin/stdout. One `McpServer` for the process lifetime, one client. No auth — the spec says stdio servers shouldn't implement it; trust is implicit, since you're running your own code as yourself. Used by the Inspector, Cursor and Claude Desktop.
- **Streamable HTTP** (`packages/server/src/http.ts`, `pnpm start:http`, `PORT` default 4768, `MCP_MODE=stateful|stateless`, default stateful): a standalone process, used by `packages/client` and `packages/web` (`MCP_SERVER_URL`).
  - **Stateless:** `POST /mcp` builds a fresh `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request. `GET`/`DELETE` return 405. Any instance can answer any request, so it scales horizontally. A client cancel cannot reach a running call: the cancel is its own POST, handled by a fresh `McpServer` that has no record of the call (verified: the upstream fetch only stopped at the 8s timeout).
  - **Stateful:** `sessionIdGenerator: randomUUID`. `initialize` returns an `Mcp-Session-Id` header and the client sends it on every later request (unknown id → 404, missing on non-initialize → 400). `createSession` builds one `McpServer` + transport per client and registers it in the `sessions` Map from `onsessioninitialized`; `transport.onclose` removes it. `sweepIdleSessions` closes sessions idle longer than `MCP_SESSION_TTL_MS` (default 30 min), and shutdown closes all of them. `GET` (server-push stream) and `DELETE` (end session) are routed to the session's transport. Per-client data lives in the `SessionState` passed to `createServer(session)`. A cancel reaches the running call (verified: upstream fetch stopped at 2s). Session state is in memory, so a restart forgets every session; run a single instance or use sticky routing by session id; proxies must not buffer the event stream.
- **Progress** (`notifications/progress`) works in **both** HTTP modes: updates stream back on the same POST that made the call. Only send them when `extra._meta?.progressToken` is present. It does not need stateful mode.
- **Cancellation:** the handler's `extra.signal` aborts when the client sends `notifications/cancelled`. The SDK only flips the signal; the handler must pass it to whatever work it started (`fetch(url, { signal })`). The web dashboard's Cancel button goes through `/api/cancel` (a route handler) because Server Actions from the browser run one at a time.
- **Client recovery:** a client whose session id the server no longer knows gets a 404 (`StreamableHTTPError`, `code: 404`). The web dashboard's `withClient()` drops the cached client, reconnects and retries once. A down server gives `TypeError: fetch failed` with no code, which is not retried.

## Logging inside a stdio server

Always `console.error`, never `console.log`. stdout is the JSON-RPC channel; anything else printed there corrupts the protocol stream.

## Two instances, not one

Every client connection spawns its own fresh server process. `pnpm start` running in a terminal and an Inspector/client connection are two separate, unrelated instances of the same code — they share no state, and nothing sent to one shows up in the other.
