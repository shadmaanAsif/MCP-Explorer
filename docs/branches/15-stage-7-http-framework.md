# #15 — Stage 7: HTTP framework, Hono (`15-stage-7-http-framework`)

**Status:** built and merged in PR 15. It also carries a small docs cleanup (the Stage 6 wording and the roadmap renumbering after Stages 7 and 8 were inserted).

## What it does

[`http.ts`](../../packages/server/src/http.ts) was about 170 lines of hand-written `node:http`: reading and parsing the body, matching the path, setting status codes, handling errors. This stage swaps that layer for **Hono**, a small typed router with middleware, so the later stages (authentication, rate limits, logging) have a proper place to plug in. **Behaviour is meant to stay the same.**

## What changed

- **One app, one route:** `app.all('/mcp')` sends each request to the stateful or stateless handler, chosen by `MCP_MODE` as before. `app.notFound` returns an empty 404, and `app.onError` returns a JSON-RPC 500.
- **Serving:** `@hono/node-server` replaces `http.createServer`. Ports, log lines and the SIGTERM shutdown are unchanged.
- **Transport:** the server now uses the SDK's `WebStandardStreamableHTTPServerTransport`, whose `handleRequest(Request)` returns a `Response`. That is what Hono speaks. The Node transport used before is a wrapper around it.
- **Stateless cleanup:** the old code closed the transport and server on `res.on('close')`. A web-standard `Response` has no socket to listen on, so `afterBody()` wraps the body stream and runs the cleanup when the stream ends or the client leaves.
- **Middleware slot:** a request-log middleware (`POST /mcp 200 12ms`) runs for every request. Authentication (Stage 9), Origin checks and rate limits (Stage 10) and tracing (Stage 12) are meant to go in the same place.
- **Dependencies:** `hono` and `@hono/node-server` are now declared in [`packages/server/package.json`](../../packages/server/package.json). They were already in the lockfile because the SDK depends on them, so the lockfile only grew by a few lines.

What did **not** change: the `sessions` Map, `createSession`, `sweepIdleSessions`, `SessionState`, `create-server.ts`, and every client.

## How to connect and try it

Nothing about connecting changes. The URL is still `http://localhost:4768/mcp`. See [connecting-clients.md](../connecting-clients.md).

```bash
pnpm build
pnpm start:http
```

Each request now prints a log line on the server, for example `[mcp-demo] POST /mcp 200 4ms`.

## Verified

- The 56 tests from Stage 6 pass **without any edits**. They cover the status codes, session routing, cancel in both modes, the idle sweep and progress streaming.
- 6 new tests in [`http.test.ts`](../../packages/server/test/http.test.ts), 3 per mode: an unknown path returns 404, a malformed JSON body returns a JSON-RPC 500 and the server keeps serving, and the request log is written. The suite is now 62 tests and passed 3 runs in a row.
- Breaking the code on purpose was caught: removing `onError` failed the malformed-body tests, and breaking the log middleware failed the log tests.
- With a temporary log in the built file, 7 stateless requests produced 7 cleanups.
- `pnpm client` against the new server printed the tools, progress, resources and results.

## Not verified, and known differences

- **Not run:** the web dashboard, Cursor and the Inspector against the new server. A client that disconnects mid-stream in stateless mode was tested only through the cancel test.
- **Malformed JSON still returns 500**, as before. 400 with `-32700` would be more correct, but this stage keeps behaviour unchanged.
- **Query strings:** the old code returned 404 for `/mcp?x=1`, and Hono ignores the query. I did not test this.
