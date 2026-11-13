# Plan: Stage 10, authorization and hardening

**Phase 2, stage 2 of 5.** Branch: `20-stage-10-authorization-hardening` (number set when the branch is cut, see D6). Status: in progress (10.1 and 10.2 built).

## Goal

Stage 9 answers "who is calling?". Stage 10 answers "what may they do, and what did they do?". A valid token is no longer enough to call every tool: each tool needs a scope the token carries. The server also refuses requests from the wrong origin, limits how much any one caller can send, and writes one audit line per tool call.

## You can do this when it's done

Make two tokens, one with `weather:use` and one with `review:run`. The first can call `get_weather` but gets `403` on `run_checks`. The second is the other way round. Send a request with a foreign `Origin` header and get `403`. Send a huge body and get `413`. Hammer the server and get `429` with `Retry-After`. Every tool call, allowed or denied, shows up as one JSON line in the audit log.

## Starting point (already built in Stage 9)

- The bearer middleware verifies the token and stores `{ subject, scopes }` on the request (`c.get('auth')`). Nothing reads the scopes yet.
- `http.ts` ends its middleware list with a comment: Origin checks and rate limits go here.
- `WebStandardStreamableHTTPServerTransport.handleRequest` accepts an `authInfo` option, and the SDK source passes it to `onmessage`. Whether it reaches a tool as `extra.authInfo` is **checked in 10.4**, where the audit log needs it.

## Decisions

| # | Decision | Proposal | Status |
|---|---|---|---|
| D1 | Scope names | Keep `mcp:tools` as the minimum to reach `/mcp`. Add `weather:use` (the six weather tools), `review:read` (`get_diff`, `read_file`, the `repo://file` resource, the `review_code` prompt) and `review:run` (`run_checks`, the only tool that runs commands). | proposed |
| D2 | Where to enforce | One place, not a check in every tool: a mapping `tool name → required scope` and a Hono middleware (`src/auth/scopes.ts`) that reads the JSON-RPC message and answers `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`. A tool missing from the table is denied. | **decided, built in 10.1.** Hono caches the parsed body, so the handlers read it again (tested). |
| D3 | Hide tools a caller can't use | `tools/list` returns only the tools the token allows. | **skipped** for Stage 10: a caller sees all tools and gets `403` on a call it may not make |
| D4 | Session belongs to its caller | In stateful mode a session remembers the `sub` that created it. A later request with that session id and a different `sub` gets `403`. | **built in 10.1** |
| D5 | Where the audit log goes | One JSON line per tool call to stderr (stdout is reserved for stdio). Optional `AUDIT_LOG_FILE`. Argument **values are not logged**, only the argument names, because they can hold paths and secrets. | proposed |
| D6 | Order with the `review.ts` split | Split first (branch 19, merged), so Stage 10 touches small files. Stage 10 is branch 20. | **decided, done** |
| D7 | Auth on by default | Phase 2 ends with auth on. Proposal: in 10.5 the server refuses to start with `NODE_ENV=production` and `AUTH_REQUIRED` not `1`. The default stays off for local use. | proposed |

## Steps

**10.1 Scopes per tool. (built)**
Add `src/auth/scopes.ts` with the tool-to-scope map and a middleware that runs after `bearerAuth`. Add the session-to-caller check (D4). Update the docs with the new scope names.
*Files:* `src/auth/scopes.ts` (new), `src/http.ts`, `test/auth-scopes.test.ts` (new).
*Done when:* a token with only `weather:use` can call `get_weather` and gets `403` on `run_checks`; a session id used with another `sub` gets `403`; a test fails when the scope check is removed.

**10.2 `Origin` check. (built)**
The spec says a server MUST validate `Origin` on HTTP, to stop DNS rebinding from a browser. `ALLOWED_ORIGINS` (comma list, default: the dashboard's origin and `http://localhost`). A request with no `Origin` (curl, the CLI, Cursor) is allowed. A listed or missing origin passes, anything else gets `403`. Check whether the SDK's own host validation is worth using as well.
*Files:* `src/http-guards.ts` (new), `src/http.ts`, tests.
*Done when:* `curl -H 'Origin: http://evil.test'` gets `403`, the dashboard still works, and a test covers both.

**10.3 Rate and size limits.**
Hono's `bodyLimit` for the size cap (`MAX_BODY_BYTES`, default 1 MB, `413`). An in-memory token bucket per caller (the `sub`, or the client address when auth is off) with `RATE_LIMIT_PER_MINUTE` and a `429` with `Retry-After`. The limits live in memory, so they are per instance; Stage 11 revisits that.
*Files:* `src/http-guards.ts`, `src/http.ts`, tests with a short window.
*Done when:* an oversized body gets `413`, a burst past the limit gets `429` and recovers after the window.

**10.4 Audit log.**
One JSON line per tool call: time, `sub`, session id, tool, `allowed` or `denied` (with the missing scope), `ok` or `error`, duration. No argument values. Written by one function that the scope middleware and the tool path both call.
*Files:* `src/audit.ts` (new), `src/http.ts`, tests that read the lines back.
*Done when:* a denied call and an allowed call each produce one correct line, and no test output contains an argument value.

**10.5 Validated config and secrets.**
One `src/config.ts` that reads every env var with zod, applies defaults and fails at startup with a message that names the bad variable. Secrets (the key file path is fine, key material is not) are never printed. D7 lives here.
*Files:* `src/config.ts` (new), `src/http.ts`, `src/auth/*`, `test/config.test.ts`.
*Done when:* a bad `MCP_SERVER_PORT` or a missing `ISSUER_URL` under `AUTH_REQUIRED=1` stops the server with a clear message, and the docs list every variable.

Then the branch doc (with **Try it end to end** as its last section, per `constitution/planning.md`), the README row and the roadmap page.

## Behaviour table (the proof)

| Request | Answer |
|---|---|
| Valid token, tool inside its scopes | works, one `allowed` audit line |
| Valid token, tool outside its scopes | `403 insufficient_scope`, one `denied` audit line |
| Valid token, session id created by another `sub` | `403` |
| `Origin` not in `ALLOWED_ORIGINS` | `403` |
| No `Origin` header | works |
| Body over `MAX_BODY_BYTES` | `413` |
| Over the rate limit | `429` with `Retry-After` |
| Bad config at startup | the server does not start, the message names the variable |

## Risks

- **Reading the body in middleware.** Resolved in 10.1: Hono caches the parsed body, so reading it in the guard costs nothing extra. A very large body is still read before the size limit unless 10.3 puts `bodyLimit` first, which it should.
- **Rate limits per instance.** Two instances behind a proxy each allow the full rate. Fine for now, a known gap until Stage 11.
- **Scopes are only as good as the issuer.** Our issuer signs whatever `--scope` you type. A real provider decides who gets which scope.
- **`Origin` is not authentication.** It only stops browsers on other sites. Non-browser callers can send any `Origin` or none, so the token is still the real gate.

## Out of scope

Role management or a user database, scope consent screens, per-argument permissions (for example which folders `read_file` may open per user), revoking a token before it expires, distributed rate limiting (Stage 11).
