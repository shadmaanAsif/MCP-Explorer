# #10 — Stage 4: error handling, progress and stateful HTTP (`10-stage-4-error-handling-realtime`)

**Status:** merged into `main` (PR [#10](https://github.com/shadmaanAsif/MCP-Explorer/pull/10)). Stage 4 was finished by [#11](11-stage-4-wrapup.md) and [#12](12-stage-4-verify-docs.md).

## What it did

Took the server from "it works when everything goes right" to "it behaves sensibly when it does not", and added sessions so the server can remember a client. Three parts.

## Part A: error handling in `get_weather`

In [`fetchWeather()`](../../packages/server/src/create-server.ts):
- **8s timeout per attempt**, up to **3 attempts**, with backoff of 300ms then 600ms.
- **Retries only on** 5xx, timeout and network errors. A 4xx, invalid JSON or an unexpected response shape returns an error immediately, because retrying cannot fix those.
- The final message ends with `(gave up after 3 attempts)`. The worst case against a hung upstream is about 25s.
- **`OPEN_METEO_URL`** overrides the API address, so the failure paths can be tested against a local stub.
- The caller's cancel signal (`extra.signal`) aborts the in-flight `fetch` and stops the retry loop.
- Do not use `AbortSignal.timeout()` inside `AbortSignal.any()` on Node 20: the timeout signal can be garbage-collected and never fire. The code uses an `AbortController` with `setTimeout` and clears the timer in `finally`.

## Part B: progress with `get_weather_batch(locations)`

- Takes 1 to 5 named locations and fetches them one at a time with `fetchWeather`. After each one it sends `notifications/progress`, but only if the client asked (it sent a progress token: `onprogress` in the client SDK).
- One failing location shows as `ERROR - …` in the output without failing the batch. The call is an error only if every location failed.
- [`client.ts`](../../packages/client/src/client.ts) calls it with `onprogress` and `resetTimeoutOnProgress: true`.
- Progress works in **both** HTTP modes: updates stream back on the same POST that made the call.

## Part C: stateful Streamable HTTP

In [`http.ts`](../../packages/server/src/http.ts):
- `MCP_MODE=stateful|stateless` (default `stateful`). `PORT` and `MCP_SESSION_TTL_MS` also apply.
- `createSession` builds one `McpServer` and transport per client and stores them in the `sessions` Map, keyed by the id the server issues on `initialize`.
- `handleStateful` routes by the `Mcp-Session-Id` header: a known id goes to that session, an unknown id gets 404, and a missing id on anything but `initialize` gets 400.
- `sweepIdleSessions` closes idle sessions, and shutdown closes all of them.
- Per-session state lives in a `SessionState` object passed to `createServer(session)`. The tools `set_home_location` and `get_home_weather` use it.
- Sessions are in memory only. A restart forgets them, and the next request with an old id gets 404.

| | stateless | stateful (default) |
|---|---|---|
| `McpServer` | new per POST, discarded after | one per session, kept in the `sessions` Map |
| Remembers a client | no | yes (`SessionState`) |
| Client cancel reaches a running call | no | yes |
| Scales behind a load balancer | any instance can answer | needs sticky routing or a shared store |

## Also in this branch

- The dashboard got a JSON textarea for array and object arguments (such as `locations`).
- `"sourceMap": true` in `tsconfig.base.json`, so VS Code breakpoints in `.ts` files bind.

## How to try it

```bash
pnpm build
pnpm start:http     # terminal 1 (stateful by default)
pnpm client         # terminal 2: runs add, divide, get_weather and get_weather_batch with progress
```

In the Inspector, Cursor or the dashboard, call `get_weather_batch` with a list such as:
```json
[{"name":"Dubai","latitude":25.2,"longitude":55.27},{"name":"Delhi","latitude":28.61,"longitude":77.21}]
```
To see state kept per client, run `set_home_location` and then `get_home_weather` in stateful mode, then repeat with `MCP_MODE=stateless pnpm start:http` and watch it forget. Connection steps: [connecting-clients.md](../connecting-clients.md).
