# #2 — Side exploration: write a client from scratch (`explore-mcp-client`)

**Status:** merged into `main` (PR [#2](https://github.com/shadmaanAsif/MCP-Explorer/pull/2)), and kept up to date as the server grows.

## What it did

Everything before this covered the server half of the protocol. This branch wrote the other half: a minimal **client** in plain code, with no Inspector and no UI. It was a parallel exploration, not one of the numbered server stages. The branch was created before the numbering convention, so it keeps its original name. It is #2 in the global counter.

## What it does

[`packages/client/src/client.ts`](../../packages/client/src/client.ts) connects to the running server, calls `listTools()`, then `callTool()` against every tool:
- `add(2, 3)`
- `divide(10, 2)`
- `divide(10, 0)`, to show a validation rejection coming back as data (`isError: true`) instead of a thrown exception
- `get_weather`

It also confirms that the client/server relationship holds whoever is on the client end: a human clicking buttons, or a few lines of TypeScript. It is a convenient scripted way to re-check every tool at once.

## How to try it

```bash
pnpm build
pnpm start:http     # terminal 1
pnpm client         # terminal 2
```

(When this branch was written the client launched the server itself over stdio. Since [#8](08-server-http-transport.md) it connects over HTTP, so the server has to be running first.) More in [connecting-clients.md](../connecting-clients.md).

## How the client changed later

- **#6**: server and client became separate packages. The client could no longer assume the server's build output was a sibling file, so it resolved the path itself relative to its own file location.
- **#7**: that resolution moved from module load time into `connectToServer()`, and `import.meta.dirname` was replaced by `path.dirname(fileURLToPath(import.meta.url))`. Next.js's build imports this module without calling `connectToServer()`, and in that context (and under Turbopack's externalized-module loader at runtime) `import.meta.dirname` came back `undefined`.
- **#8**: all path resolution is gone. `connectToServer(url?)` in [`connection.ts`](../../packages/client/src/connection.ts) uses `StreamableHTTPClientTransport` and a URL (`MCP_SERVER_URL`, default `http://localhost:4768/mcp`), so the client no longer needs to know where the server lives, or even that it is on the same machine.
