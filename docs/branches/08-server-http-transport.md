# #8 — Side exploration: Streamable HTTP transport (`08-server-http-transport`)

**Status:** merged into `main` (PR [#8](https://github.com/shadmaanAsif/MCP-Explorer/pull/8)).

## What it did

Gave the server a second way to run. Until now every client launched the server itself over stdio. This branch added a standalone HTTP entry point, so one server process can be reached by URL, by clients that never spawn it.

## What changed

- The tools moved into [`create-server.ts`](../../packages/server/src/create-server.ts) as a `createServer()` factory, so there is one server definition.
- Two entry points connect it to a transport:
  - [`index.ts`](../../packages/server/src/index.ts): **stdio**. One `McpServer` for the life of the process, spawned by the client. `pnpm start`.
  - [`http.ts`](../../packages/server/src/http.ts): **Streamable HTTP**. A standalone process listening on `PORT` (default `4768`) at `/mcp`. `pnpm start:http`. Other paths return 404, and non-POST requests returned 405.
- The first HTTP version was **stateless**: every `POST /mcp` built a fresh `McpServer` and transport (`sessionIdGenerator: undefined`) and discarded them when the response closed. Stateful mode came in [#10](10-stage-4-error-handling-realtime.md).
- The client moved onto it: `connectToServer(url?)` uses `StreamableHTTPClientTransport` and a URL (`MCP_SERVER_URL`, default `http://localhost:4768/mcp`). It no longer spawns a process or needs to know where the server's build output is.

## stdio versus HTTP

| | stdio | Streamable HTTP |
|---|---|---|
| Who starts the server | the client | you |
| Reach | same machine only | any machine that can reach the URL |
| Instances | one per connection | one for everyone |

Reasons to pick HTTP: remote clients, one deployment for everyone, secrets kept in one place, and a single place for auth, rate limits and logging. Reasons to pick stdio: it is simpler, it is isolated per client, and it needs no auth.

## How to try it

```bash
pnpm build
pnpm start:http     # terminal 1
pnpm client         # terminal 2
```

The Inspector and Cursor can use either transport. Step by step: [connecting-clients.md](../connecting-clients.md).

## Notes

- A running HTTP server does not pick up a rebuild. Restart it.
- Only plain `http://` is served. HTTPS needs something in front of it (a reverse proxy or tunnel); TLS is planned for Stage 13.
