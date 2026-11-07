# #1 — Stage 1: basic server (`stage-1-basic-server`)

**Status:** merged into `main`.

## What it did

Built the smallest working MCP server: one file, one tool (`add`), no extra layers. The point was to see the three pieces everything else grows from: **server → tool → transport**.

## What changed

- Created the server with `new McpServer({ name, version })`. This is the object a client talks to.
- Registered one tool, `add`, with `server.registerTool('add', { ...schema }, handler)`. The handler receives already-validated `{ a, b }` and returns their sum as text.
- Connected a `StdioServerTransport`. "stdio" means the client talks to the process over stdin/stdout instead of a network port, so the client just launches the process and starts writing and reading.

## Dependencies

- **`@modelcontextprotocol/sdk`**: implements the protocol (message formats, server and client objects, transports). Without it we would hand-write JSON-RPC handling.
- **`zod`**: a schema library. The `add` schema says "two numbers, `a` and `b`". The SDK uses it twice: to tell clients what input to send, and to reject bad input at runtime.
- **`typescript`, `@types/node`** (dev only): the compiler and Node's type definitions.

Giving `add` a schema is not "input validation" in the Stage 2 sense. It is simply how any tool declares its shape.

## Why the server does nothing by itself

An MCP server only responds when a client sends a request. Messages are JSON-RPC, for example `{"method":"tools/call","params":{"name":"add","arguments":{"a":2,"b":3}}}`, sent over the process's stdin with replies on stdout. This is why logs use `console.error` (stderr): anything extra on stdout would corrupt the protocol.

## How to try it

At this stage the only client was the Inspector over stdio. Today:

```bash
pnpm build
pnpm dlx @modelcontextprotocol/inspector node packages/server/build/index.js
```

Open the URL it prints (it contains a proxy token), confirm Command `node` and Arguments `packages/server/build/index.js`, click **Connect**, open the **Tools** tab and run `add`. Every **Connect** spawns a brand-new copy of the server, separate from any `pnpm start` you have open. Full steps for every client: [connecting-clients.md](../connecting-clients.md).

## Notes

- The repo was a single flat package at this point. It was later split into a monorepo ([#6](06-monorepo-server-client-split.md)).
- The branch was created before the numbering convention, so it keeps its original name. It is #1 in the global counter.
