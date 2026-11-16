# #20 — Stage 10: authorization and hardening (`20-stage-10-authorization-hardening`)

**Status:** in progress. 10.1 to 10.4 built; 10.5 not started. Plan: [docs/plans/stage-10-authorization-hardening.md](../plans/stage-10-authorization-hardening.md).

Stage 9 answers "who is calling?". Stage 10 answers "what may they do, and what did they do?".

## Steps at a glance

| Step | What it builds | Status |
|---|---|---|
| 10.1 | Scopes per tool, and a session that belongs to its caller | Built |
| 10.2 | `Origin` check | Built |
| 10.3 | Rate and size limits | Built |
| 10.4 | Audit log | Built |
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

## 10.3 Rate and size limits

**The problem:** one caller could send a huge body, or thousands of requests a minute, and starve everyone else.

**What it is:** two Hono middlewares in [`src/http-guards.ts`](../../packages/server/src/http-guards.ts), both in front of `/mcp`.

| Limit | Setting | Default | Answer when passed |
|---|---|---|---|
| Body size | `MAX_BODY_BYTES` | 1048576 (1 MB) | `413`, before anything reads the body |
| Request rate | `RATE_LIMIT_PER_MINUTE` | 120, `0` turns it off | `429` with a `Retry-After` header (seconds) |

- **How the rate works:** a token bucket per caller. It holds up to the per-minute number of tokens and refills steadily, so a short burst is fine and a steady rate above the limit is refused. After a `429`, waiting `Retry-After` seconds frees a request.
- **Who the caller is:** the token's `sub` when auth is on, so one caller can't starve another. With auth off it is the client address.
- **Order:** Origin check, then size, then the token and scope guards, then the rate limit. The rate limit sits after auth so it can see the `sub`. A caller with no valid token gets `401` before it is counted.
- **Per instance:** the buckets live in this server's memory. Two instances each keep their own count. Stage 11 revisits that.
- **Bad values:** a non-number or negative setting falls back to the default.

**Proof:** unit tests for the bucket (burst, separate callers, refill, Retry-After, idle cap) and the two middlewares, plus 4 end-to-end tests: `413`, `429` and recovery after a second, the limit switched off, and one caller not starving another. With the size and rate lines removed, the `413` and `429` tests fail. 215 tests pass.

**Not done:** the limit is not per tool, and failed auth attempts are not rate limited.

## 10.4 Audit log

**The problem:** with scopes, a call can now be allowed or refused, and nothing recorded who did what. After a bad day you could not answer "who ran `run_checks`, and when?".

**What it is:** one JSON line on the server's stderr for every tool call, from [`src/audit.ts`](../../packages/server/src/audit.ts).

```json
{"type":"audit","time":"2026-11-16T09:30:00.000Z","sub":"alice","session":"3f1c…","tool":"add","decision":"allowed","outcome":"ok","ms":3}
{"type":"audit","time":"2026-11-16T09:30:02.000Z","sub":"alice","session":"3f1c…","tool":"run_checks","decision":"denied","missing":["review:run"]}
```

| Field | Meaning |
|---|---|
| `sub` | the token's `sub`, or `null` when auth is off |
| `session` | the `Mcp-Session-Id`, or `null` (stateless mode) |
| `tool` | the tool's name |
| `decision` | `allowed` or `denied` |
| `missing` | the scopes the caller lacked (denied only) |
| `outcome`, `ms` | `ok` or `error`, and how long it took (allowed only) |

**How it is written:**
- **Allowed calls:** one wrapper around the SDK's single `tools/call` handler. Every tool is covered, a new tool needs no logging code, and so are an unknown tool name and a call whose arguments fail validation. The `sub` reaches it because `http.ts` now passes the verified caller to the SDK as `authInfo` (the token itself is not passed).
- **Denied calls:** `scopeGuard` writes one line per tool the caller tried, then answers `403`.
- **stdio:** nothing is logged, because there are no callers to tell apart.

**What is never logged:** argument values and results. Only the tool name. Read it with `grep '"type":"audit"'`.

**Not covered:**
- **Other refusals:** a `401`, an Origin `403`, a `413` and a `429` are not audit lines. They stop before a tool is named, and the normal request log already shows their status.
- **Other messages:** listing tools, reading a resource and getting a prompt are not logged, only `tools/call`.
- **A separate debug log:** the tools' own `console.error` lines, such as `add called with a=…`, still print argument values to stderr. They are not part of the audit log, and I did not change them.
- **No file or shipping:** it is stderr only. Sending it somewhere is Stage 12.

**Proof:** 6 unit tests (`test/audit.test.ts`: allowed, error, unknown tool, listing, a review tool) and 2 end-to-end tests against the real server: one allowed and one denied line with the right fields and none of the argument values, and `sub: null` with auth off. With the wrapper and the denied-line write removed, 6 tests fail. 223 tests pass.

## Testing in MCP clients

The `curl` steps in "Try it end to end" prove the server. This section is for trying the same limits from a real client. **Nothing here has been run in Cursor, the Inspector or Claude Code yet.** Stage 9 showed that Cursor connects with a token in `headers`. What Cursor shows for a `403` or `429` is not known, so check its MCP log if the chat shows only a generic failure.

**Setup for all of them:** start the issuer and the server with `AUTH_REQUIRED=1` (see step 1 of "Try it end to end"), then make tokens with the scopes you want to test.

| Token | Command |
|---|---|
| Weather only | `pnpm --silent issuer token --sub alice --scope "mcp:tools weather:use" --ttl 86400` |
| Everything | `pnpm --silent issuer token --sub carol --scope "mcp:tools weather:use review:read review:run" --ttl 86400` |

### Cursor

1. Put the weather-only token in `.cursor/mcp.json`, then toggle the server off and on in Cursor Settings, MCP:
   ```json
   {
     "mcpServers": {
       "mcp-demo-http": {
         "url": "http://localhost:4768/mcp",
         "headers": { "Authorization": "Bearer <weather-only token>" }
       }
     }
   }
   ```
2. **Scopes (10.1):** ask "use the add tool to add 2 and 3". It should work. Ask "use run_checks to run the test check". It should be refused with a `403`, because the token has no `review:run`. Swap in the "everything" token, toggle the server, and the same request should run.
3. **Rate limit (10.3):** set `RATE_LIMIT_PER_MINUTE=3` in `packages/server/.env`, restart the server, and ask the agent to call `add` five times in a row. Later calls should fail with a rate limit error. Wait a minute and it recovers. Set it back afterwards.
4. **Origin (10.2):** Cursor is a desktop app, and I expect it to send no `Origin`, so it should pass. I have not confirmed that. If it gets a `403 Origin not allowed`, add the origin it sends to `ALLOWED_ORIGINS`.
5. **Size limit (10.3):** a chat request is too small to reach the 1 MB default. Use the `curl` step in "Try it end to end" instead.

### MCP Inspector

The Inspector runs in a browser, so it **does send an `Origin`**. Without a change the server refuses it with `403 Origin not allowed`. This is the easiest client for seeing the Origin check.

1. Start it with `pnpm dlx @modelcontextprotocol/inspector`. Note the address it prints. I believe it is `http://localhost:6274`, but use whatever it shows.
2. Choose transport "Streamable HTTP", enter `http://localhost:4768/mcp`, and add `Authorization: Bearer <token>` in its Authentication section.
3. Connect. Expect a failure with `Origin not allowed`.
4. Add the Inspector's address to `packages/server/.env` as `ALLOWED_ORIGINS=http://localhost:4767,http://127.0.0.1:4767,http://localhost:6274`, restart the server and connect again. It should work. Listing and calling tools then shows the scope check, as in the Cursor steps.

If the Inspector's proxy makes the requests from its own Node process, no `Origin` is sent and step 3 won't fail. I have not checked which it does.

### Claude Code

```bash
claude mcp add --transport http mcp-demo http://localhost:4768/mcp --header "Authorization: Bearer <weather-only token>"
```
Then ask it to call `add` (works) and `run_checks` (refused with `403`). The same untested caveat applies.

### What you should see

| Check | Client result |
|---|---|
| Tool the token's scopes allow | normal result |
| Tool it lacks the scope for | `403 insufficient_scope`, naming the missing scope |
| Session id used with another caller's token | `403` |
| Browser origin not in `ALLOWED_ORIGINS` | `403 Origin not allowed` |
| More than `RATE_LIMIT_PER_MINUTE` calls in a minute | `429`, then fine after the `Retry-After` seconds |
| Body over `MAX_BODY_BYTES` | `413` |
| Any `tools/call`, allowed or refused | one `"type":"audit"` line in the server's terminal, with no argument values |

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
8. Check the size limit. Set `MAX_BODY_BYTES=200` in `packages/server/.env`, restart the server, and send a larger body. Expect `413`:
   ```bash
   curl -si -X POST localhost:4768/mcp -H "Authorization: Bearer $WEATHER" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"padding\":\"$(printf 'x%.0s' {1..300})\"}" | grep -iE "^HTTP"
   ```
9. Check the rate limit. Set `RATE_LIMIT_PER_MINUTE=5`, restart, and send seven requests. The last ones should be `429` with a `Retry-After` line:
   ```bash
   for i in 1 2 3 4 5 6 7; do curl -si -X POST localhost:4768/mcp -H "Authorization: Bearer $WEATHER" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' | grep -iE "^HTTP|retry-after"; done
   ```
10. Check the audit log. In the server's terminal, each call above should have left one line. Stop the running server, then restart it with its output filtered:
    ```bash
    pnpm start:http 2>&1 | grep '"type":"audit"'
    ```
    Run steps 4 and 5 again with that running. Expect an `allowed` line for a permitted call and a `denied` line with `"missing":["review:run"]` for the refused `run_checks`. Neither line should show the arguments.
11. Remove the settings from steps 8 and 9, turn auth off again (`AUTH_REQUIRED=0`) and restart the server.

Steps 4 to 10 are the same checks the tests make; I have not run these exact `curl` lines by hand. Steps for 10.5 are added as each is built.
