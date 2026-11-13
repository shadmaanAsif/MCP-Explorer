# #20 — Stage 10: authorization and hardening (`20-stage-10-authorization-hardening`)

**Status:** in progress. 10.1 and 10.2 built; 10.3 to 10.5 not started. Plan: [docs/plans/stage-10-authorization-hardening.md](../plans/stage-10-authorization-hardening.md).

Stage 9 answers "who is calling?". Stage 10 answers "what may they do, and what did they do?".

## Steps at a glance

| Step | What it builds | Status |
|---|---|---|
| 10.1 | Scopes per tool, and a session that belongs to its caller | Built |
| 10.2 | `Origin` check | Built |
| 10.3 | Rate and size limits | Not started |
| 10.4 | Audit log | Not started |
| 10.5 | Validated config and secrets | Not started |

## 10.1 Scopes per tool

**The problem:** after Stage 9 any valid token could call every tool. The token's `scope` was read but nothing used it.

**What it is:** one table, `TOOL_SCOPES` in [`src/auth/scopes.ts`](../../packages/server/src/auth/scopes.ts), and one Hono middleware, `scopeGuard`, that runs after `bearerAuth` (only with `AUTH_REQUIRED=1`).

| Scope | Allows |
|---|---|
| `mcp:tools` | Reaching `/mcp` at all (listing, initialize). Always needed. |
| `weather:use` | `add`, `divide`, `get_weather`, `get_weather_batch`, `set_home_location`, `get_home_weather` |
| `review:read` | `get_diff`, `read_file`, the `repo://file/…` resource, the `review_code` prompt |
| `review:run` | `run_checks`, the only tool that starts processes |

**What the guard does:** it reads the JSON-RPC message (each one, if it is a batch), finds the scope it needs, and compares it with the token's scopes. Missing scope gives `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<what is missing>"`. A tool that is not in the table is denied, so a new tool must be mapped before anyone can call it.

**Session owner:** a stateful session remembers the `sub` that opened it. The same session id with another caller's valid token gets `403`.

**Breaking change from Stage 9:** a token with only `mcp:tools` can still list tools but can no longer call any. Make tokens with the scopes they need:
```bash
pnpm --silent issuer token --sub alice --scope "mcp:tools weather:use"
```

**Proof:** `test/auth-scopes.test.ts` (unit, each row above, batches, unknown tools) and two end-to-end tests in `http.test.ts`. With the guard and the owner check removed, both end-to-end tests fail. 194 tests pass.

**Not done in 10.1:** hiding tools from `tools/list` (skipped, D3); who may get which scope (the issuer signs whatever `--scope` you type).

## 10.2 Origin check

**The problem:** a web page open in your browser can send requests to `http://localhost:4768`. With DNS rebinding it can even look like the same site. The MCP spec says an HTTP server must check the `Origin` header to stop this.

**What it is:** a Hono middleware, `originGuard`, in [`src/http-guards.ts`](../../packages/server/src/http-guards.ts). It runs in front of `/mcp`, before the token checks, and it is always on (not behind `AUTH_REQUIRED`).

| Request | Answer |
|---|---|
| No `Origin` header (curl, the CLI, the dashboard's server side, Cursor) | passes |
| `Origin` in the allowed list | passes |
| Any other `Origin`, including `null` from a sandboxed page | `403 Origin not allowed` |

- **The list:** `ALLOWED_ORIGINS` in `packages/server/.env`, comma-separated. Unset means the dashboard's own origins, `http://localhost:4767` and `http://127.0.0.1:4767`. Comparison ignores case and a trailing slash.
- **Browser-based tools:** a client that runs in a browser, such as the Inspector, sends its own origin (for example `http://localhost:6274`). Add it to `ALLOWED_ORIGINS`. I have not tried the Inspector against this.
- **Not covered:** the `.well-known` notice routes are public and have no check. The SDK's own host validation was not used.

**Proof:** `test/http-guards.test.ts` (unit) and 5 end-to-end tests in `http.test.ts`. With the `app.use(... originGuard ...)` line removed, 3 of them fail. 203 tests pass.

## Try it end to end

1. Turn auth on in `packages/server/.env` (`AUTH_REQUIRED=1`), then build:
   ```bash
   pnpm build
   ```
2. Start the issuer and the server in two tabs:
   ```bash
   pnpm issuer serve
   ```
   ```bash
   pnpm start:http
   ```
3. Make a token that can use weather only, and one that can also run checks:
   ```bash
   export WEATHER=$(pnpm --silent issuer token --sub alice --scope "mcp:tools weather:use")
   export RUNNER=$(pnpm --silent issuer token --sub bob --scope "mcp:tools review:run")
   ```
4. Open a session as alice and note its id:
   ```bash
   curl -si -X POST localhost:4768/mcp -H "Authorization: Bearer $WEATHER" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' | grep -i mcp-session-id
   ```
5. Call `run_checks` with alice's token. Expect `403` and `scope="review:run"`:
   ```bash
   curl -si -X POST localhost:4768/mcp -H "Authorization: Bearer $WEATHER" -H "Mcp-Session-Id: <id>" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_checks","arguments":{"checks":["test"]}}}' | grep -iE "^HTTP|www-auth"
   ```
6. Use alice's session id with bob's token. Expect `403` ("belongs to another caller"):
   ```bash
   curl -si -X POST localhost:4768/mcp -H "Authorization: Bearer $RUNNER" -H "Mcp-Session-Id: <id>" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' | grep -iE "^HTTP"
   ```
7. Check the Origin guard. A foreign `Origin` gets `403`, and no `Origin` gets through:
   ```bash
   curl -si -X POST localhost:4768/mcp -H 'Origin: http://evil.test' -H "Authorization: Bearer $WEATHER" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{}' | grep -iE "^HTTP"
   ```
   Expect `403`. The same call without the `Origin` header should get past the guard (a `400` from the MCP layer for the empty body, not `403`).
8. Turn auth off again (`AUTH_REQUIRED=0`) and restart the server.

Steps 4 to 7 are the same checks the tests make; I have not run these exact `curl` lines by hand. Steps for 10.3 to 10.5 are added as each is built.
