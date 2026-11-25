# #22 — Stage 12: observability (`22-stage-12-observability`)

**Status:** in progress. Step 12.1 is built and waiting for your test run (see its "Test it yourself" section). Steps 12.2 to 12.5 are planned, nothing built. Plan: [docs/plans/stage-12-observability.md](../plans/stage-12-observability.md).

Stage 12 makes the server something you can **watch** (logs, health, metrics, traces) and something you can **stop cleanly**. Today its only window is plain text on stderr, with nothing that says which session a line belongs to.

## Steps at a glance

| Step | What it builds | Status |
|---|---|---|
| 12.1 | Structured logs: every line carries `req`, `session`, `sub` and `instance` | Built; 327 passed and 21 skipped without Redis, 348 of 348 with Redis; waiting for your test run |
| 12.2 | `/healthz` and `/readyz` on an admin port, compose healthchecks | Planned |
| 12.3 | `/metrics` with a fixed set of labels | Planned |
| 12.4 | OpenTelemetry traces | Planned |
| 12.5 | Graceful shutdown | Planned |

## 12.1 Structured logs with a session id

### What

- **`src/log.ts` (new):** one logger for the whole server. It has four levels (`debug`, `info`, `warn`, `error`), two formats (`text`, `json`) and a **request context**.
- **Three settings**, checked at startup like the others in `config.ts`:
  - `LOG_FORMAT` is `text` (default) or `json`.
  - `LOG_LEVEL` is `debug`, `info` (default), `warn` or `error`.
  - `INSTANCE_ID` names the instance in its lines. The default is the host name.
- **All 26 `console.error` calls** in the server now go through the logger: `http.ts` (13), `create-server.ts` (6), `auth/middleware.ts` (1), `review/index.ts` (3), `review/helpers/roots.ts` (1) and the stdio entry `index.ts` (2). The plan counted 20 and missed the last 6.
- **Tool-entry lines moved to `debug`.** The eight lines a tool writes when it starts (`add called with a=2, b=3`, `get_weather called with latitude=…`, `read_file <path>` and the rest) print arguments or paths, so they are off by default.
- **Audit lines carry `req`.** Their shape is otherwise unchanged, and they are still always printed.
- **Not changed:** `config.ts` startup errors and the issuer CLI keep their own `console.error` calls, as planned.

### Why

- With two instances and many clients, a line like `get_weather called with …` does not say whose call it was. You could not follow one session.
- The tool handler never receives the HTTP request, so it cannot be handed a session id by hand. The context carries it instead.
- The argument lines broke the audit log's own rule, "names only", because arguments can hold locations and file paths. At `debug` they are opt-in.

### How

**Request context.** Node has a built-in store, `AsyncLocalStorage` (`node:async_hooks`), that follows an async call: everything it awaits, every timer and promise chain it starts, can read the same value. No package is needed.

1. **The request middleware** in `http.ts` calls `runWithContext({ req })` with a fresh 8-character id and runs the rest of the request inside it.
2. **`handleStateful`** adds `session` as soon as it reads the `Mcp-Session-Id` header. For `initialize` there is no header, so it adds the id after the SDK has created it.
3. **`bearerAuth`** adds `sub` after the token check passes. The token itself is never stored in the context.
4. **Any `log.info(...)`**, however deep (a tool handler, the event store, the rebuild code), reads the context and adds `req`, `session` and `sub` to the line. An explicit field on the call wins over the context.

| Field | Where it comes from |
|---|---|
| `req` | the middleware, one per HTTP request |
| `session` | the `Mcp-Session-Id` header, or the new id for `initialize` |
| `sub` | the verified token, only when `AUTH_REQUIRED=1` |
| `instance` | `INSTANCE_ID`, or the host name |

**Why some lines pass `session` by hand.** `session X opened`, `closed`, `rebuilt`, `idle` and `could not save state` pass `{ session }` as an explicit field. They run from the SDK's callbacks, from `transport.onclose` and from the response stream, where I did not want to depend on the context reaching them.

**The two formats.** The message text is exactly what it was before, and the facts go next to it, so the things that match log text keep working (the test helper, `redis-sessions.test.ts`, `docker/kill-test.mjs`).

```
today:      [mcp-demo] session 3f1c9a opened (1 active)
text:       [mcp-demo] session 3f1c9a opened (1 active) req=7f3a9c21 session=3f1c9a instance=laptop
json:       {"time":"…","level":"info","instance":"laptop","req":"7f3a9c21","session":"3f1c9a","msg":"session 3f1c9a opened (1 active)"}
```

The session id appears twice in text mode, in the message and in `session=`. That is deliberate, so old readers keep working. Two start-up lines, `mcp-demo server running on …` and `Cannot reach Redis …`, never had the `[mcp-demo] ` prefix, so they keep going without it.

### Example, from a real run

One session on a temporary server with `LOG_FORMAT=json LOG_LEVEL=debug INSTANCE_ID=laptop`. `grep <session id>` on its log gives the whole session. Each request has its own `req`, and the `add` call has three lines that share one:

```
{"level":"info", "instance":"laptop","req":"d9fdf370","session":"9c08c463-…","msg":"session 9c08c463-… opened (1 active)"}
{"level":"info", "instance":"laptop","req":"d9fdf370","session":"9c08c463-…","msg":"POST /mcp 200 13ms"}
{"level":"info", "instance":"laptop","req":"dd055286","session":"9c08c463-…","msg":"POST /mcp 202 2ms"}
{"level":"debug","instance":"laptop","req":"75056613","session":"9c08c463-…","msg":"add called with a=2, b=3"}
{"level":"info", "instance":"laptop","req":"75056613","session":"9c08c463-…","msg":"POST /mcp 200 2ms"}
{"type":"audit","req":"75056613","sub":null,"session":"9c08c463-…","tool":"add","decision":"allowed","outcome":"ok","ms":0}
```

(Shortened here: the real lines also have a `time`, and the ids are longer.) With the default settings the same session prints today's lines plus the tail, and the `add called with` line is gone:

```
[mcp-demo] POST /mcp 200 2ms req=5f36f89d session=0d2ed697-… instance=laptop
```

### Proof

- **26 new tests:** 25 in [`test/log.test.ts`](../../packages/server/test/log.test.ts) and 1 in `config.test.ts`. 17 of the log tests need no server (formats, levels, the context across awaits and overlapping requests, `setContext`, errors). 8 start the real compiled server.
- **The spike worked.** The context survives the SDK for a `tools/call` over POST, for `initialize`, for events stored while a tool runs, for the `GET /mcp` replay stream, and for a session rebuilt on a second instance with Redis. The plan has the table.
- **Mutation checks.** Taking out the middleware's context made all 8 real-server tests fail. Taking out the session from the header made 5 fail, and taking out `sub` made 1 fail. Each file was restored from a copy and the checksums matched.
- **Compatibility.** The existing tests that read log text passed unchanged. The one that failed was the config test that lists every setting, because it now has three more, and I updated it.
- **Full suite:** 327 passed and 21 skipped without Redis, and 348 of 348 with a real Redis 7 (Docker).
- **By hand:** a server in JSON mode, then in text mode, then with `LOG_LEVEL=loud`, which exits with `Invalid configuration: LOG_LEVEL: must be debug, info, warn or error`.
- **The Docker kill test** (11.4) passed with the new build, so `docker/kill-test.mjs` still finds its lines. In the containers the instance name is the container id, because compose does not set `INSTANCE_ID` yet.

### Known limits

- **The audit lines are still always printed** and keep their own shape. `LOG_LEVEL=warn` does not hide them.
- **Not tested:** whether the context reaches lines written from the response-body stream (`afterBody`) or from `transport.onclose`. Those lines pass their session by hand, so they have it either way.
- **Per instance.** Each instance logs only what it did. Following a session across two instances means reading both logs, for example `docker compose logs server-a server-b | grep <session id>`.
- **Instance names in Docker.** The default is the host name, which is the container id. A readable name needs `INSTANCE_ID` in the compose file, which comes with the healthchecks in 12.2.
- **Text mode has no timestamp**, as before. JSON mode has `time`.
- **The 11.4 doc's expected line** `mcp-demo server running on http://localhost:4768/mcp (stateful)` is now the start of the line. It ends with ` instance=<container id>`.
- **Level names.** `warn` and `error` appear in JSON as the `level` field. In text mode the level is not printed, as before.

### New packages

None. `node:async_hooks`, `node:crypto` and `node:os` are built into Node. Steps 12.3 and 12.4 add `prom-client` and the OpenTelemetry packages, and each is explained there.

### Test it yourself (12.1)

Use a terminal on Node 24 (`nvm use 24.22.2`) from the repo root. I ran all 11 steps myself; for the server steps I started `node build/http.js` directly, not `pnpm start:http`. You have also run all of them and they work.

1. Build:
   ```bash
   pnpm build
   ```
   If `packages/web` fails with an error and the server and client built, run it again. That intermittent failure is not from this change, and I have not found its cause.
2. Run the whole suite without Redis. Expect `Tests  327 passed | 21 skipped (348)`:
   ```bash
   pnpm test
   ```
3. Run it with Redis. Skip this if your own Redis is already on port 6379, and use that one. Expect `Tests  348 passed (348)`:
   ```bash
   docker run --rm -d --name mcp-test-redis -p 6379:6379 redis:7
   ```
   ```bash
   REDIS_URL=redis://localhost:6379 pnpm test
   ```
   ```bash
   docker stop mcp-test-redis
   ```
4. Run only the new and changed tests. Expect `Tests  42 passed | 1 skipped (43)` without Redis and `43 passed (43)` with it:
   ```bash
   pnpm exec vitest run packages/server/test/log.test.ts packages/server/test/config.test.ts
   ```
5. See the JSON format. Start a server in one terminal. A variable set in the shell beats `.env`, so this works with your own settings. The server's lines go to a file, so you can search them:
   ```bash
   MCP_SERVER_PORT=4785 AUTH_REQUIRED=0 SESSION_STORE=memory LOG_FORMAT=json LOG_LEVEL=debug INSTANCE_ID=laptop pnpm start:http 2> /tmp/mcp-12-1.log
   ```
6. In a second terminal, open a session and call `add`. `$SID` holds the session id:
   ```bash
   H=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'Mcp-Protocol-Version: 2025-11-25')
   SID=$(curl -si -X POST localhost:4785/mcp "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r'); echo $SID
   ```
   ```bash
   curl -s -o /dev/null -X POST localhost:4785/mcp "${H[@]}" -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
   ```
   ```bash
   curl -s -X POST localhost:4785/mcp "${H[@]}" -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add","arguments":{"a":2,"b":3}}}'
   ```
7. Search the log for that one session. Expect JSON lines with `instance` `laptop`. The `add called with a=2, b=3` line is `debug`. It has the same `req` as the `POST /mcp 200` line after it and as the `"type":"audit"` line:
   ```bash
   grep "$SID" /tmp/mcp-12-1.log
   ```
   Stop the server with Ctrl+C when you are done.
8. See the default text format. Start the server again with no `LOG_FORMAT` or `LOG_LEVEL`, repeat step 6, and read the terminal. Expect lines like `[mcp-demo] POST /mcp 200 2ms req=5f36f89d session=… instance=…`, and **no** `add called with` line:
   ```bash
   MCP_SERVER_PORT=4785 AUTH_REQUIRED=0 SESSION_STORE=memory pnpm start:http
   ```
9. See the argument line come back. Add `LOG_LEVEL=debug` to the same command and repeat step 6. Expect `[mcp-demo] add called with a=2, b=3 req=… session=… instance=…`:
   ```bash
   LOG_LEVEL=debug MCP_SERVER_PORT=4785 AUTH_REQUIRED=0 SESSION_STORE=memory pnpm start:http
   ```
10. Check that a bad value stops the server. Expect `Invalid configuration:` then `- LOG_LEVEL: must be debug, info, warn or error`, and exit code 1:
    ```bash
    LOG_LEVEL=loud MCP_SERVER_PORT=4785 pnpm start:http
    ```
11. Check that the Docker stack still works with the new log lines. This needs `pnpm build` first (step 1). Expect six `PASS` lines and `KILL TEST PASSED`. It stays untested by you until you run it:
    ```bash
    docker compose -f docker/compose.scale.yml up -d --wait
    ```
    ```bash
    node docker/kill-test.mjs
    ```
    ```bash
    docker compose -f docker/compose.scale.yml down -v
    ```

## Try it end to end

Only 12.1 exists so far. This section grows with each step, and the full run-through comes with 12.5.

Use **two terminal tabs**. Tab 1 runs the server, on Node 24 (`nvm use 24.22.2`). Tab 2 sends requests with `curl`. Run every command from the repo root. Each part says which tab to use, what to type and what you should see, and names the matching steps in [Test it yourself (12.1)](#test-it-yourself-121).

I ran every part myself, and you have run them too and they work.

### Part 1: build and run the tests (12.1 steps 1 to 4)

1. **Tab 1:** build.
   ```bash
   pnpm build
   ```
   If `packages/web` fails and the server and client built, run it again. That failure is intermittent and its cause is not found.
2. **Tab 1:** run the suite. Expect `Tests  327 passed | 21 skipped (348)`. The skipped tests need Redis, and 12.1 step 3 runs them with Redis.
   ```bash
   pnpm test
   ```

### Part 2: the JSON format, and following one session (12.1 steps 5 to 7)

3. **Tab 1:** start the server with JSON logs and debug level. The `2>` at the end sends the server's log lines to the file `/tmp/mcp-12-1.log`, so tab 1 stays quiet. That is expected. The server writes to stderr and has no log-file setting; the file comes only from this redirect, and each run overwrites it.
   ```bash
   MCP_SERVER_PORT=4785 AUTH_REQUIRED=0 SESSION_STORE=memory LOG_FORMAT=json LOG_LEVEL=debug INSTANCE_ID=laptop pnpm start:http 2> /tmp/mcp-12-1.log
   ```
4. **Tab 2:** set the request headers once. Tab 2 keeps them for the later parts.
   ```bash
   H=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'Mcp-Protocol-Version: 2025-11-25')
   ```
5. **Tab 2:** open a session. Expect `SID=[<a UUID>]`. Do not go on until it prints one. With an empty `SID`, the next requests get `400`, and `grep` in step 8 prints the whole file.
   ```bash
   SID=$(curl -si -X POST localhost:4785/mcp "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r'); echo "SID=[$SID]"
   ```
   If it prints `SID=[]`, run the same request without the pipe to see the raw response:
   ```bash
   curl -si -X POST localhost:4785/mcp "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
   ```
6. **Tab 2:** send the handshake. It prints nothing.
   ```bash
   curl -s -o /dev/null -X POST localhost:4785/mcp "${H[@]}" -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
   ```
7. **Tab 2:** call `add`. Expect an event containing `"text":"5"`.
   ```bash
   curl -s -X POST localhost:4785/mcp "${H[@]}" -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add","arguments":{"a":2,"b":3}}}'
   ```
8. **Tab 2:** search the log for that one session.
   ```bash
   grep "$SID" /tmp/mcp-12-1.log
   ```
   Expect six JSON lines, each with `session` set to your id and `instance` set to `laptop`:
   - `session … opened (1 active)` and `POST /mcp 200`, the `initialize` call, with one `req`.
   - `POST /mcp 202`, the handshake, with its own `req`.
   - `add called with a=2, b=3`, at level `debug`.
   - The audit line, with `"type":"audit"` and `"tool":"add"`.
   - `POST /mcp 200`, the `add` call.

   The last three lines share one `req`. That is how one call is tied together. To watch lines arrive live, run `tail -f /tmp/mcp-12-1.log` in a third tab.
9. **Tab 1:** press Ctrl+C to stop the server.

### Part 3: the default text format (12.1 step 8)

10. **Tab 1:** start the server with no `LOG_FORMAT`, `LOG_LEVEL` or `2>`, so the lines print in the terminal.
    ```bash
    MCP_SERVER_PORT=4785 AUTH_REQUIRED=0 SESSION_STORE=memory pnpm start:http
    ```
11. **Tab 2:** repeat steps 5, 6 and 7. Do not repeat step 4, because `H` is still set. Run step 5 again, because the restarted server needs a new session.
12. **Tab 1:** read the lines. Expect the text before `req=` to match what the server printed before 12.1, and a `key=value` tail added. `instance` is your machine's hostname, because `INSTANCE_ID` is not set:
    ```
    [mcp-demo] session 548b73ac-… opened (1 active) req=fff1719d session=548b73ac-… instance=<hostname>
    [mcp-demo] POST /mcp 200 14ms req=fff1719d session=548b73ac-… instance=<hostname>
    [mcp-demo] POST /mcp 202 2ms req=157cd27a session=548b73ac-… instance=<hostname>
    {"type":"audit",…,"tool":"add","outcome":"ok",…}
    [mcp-demo] POST /mcp 200 3ms req=58100fc1 session=548b73ac-… instance=<hostname>
    ```
    There is **no** `add called with` line, because it is a `debug` line and the default level is `info`. Two lines look different: the startup line has no `[mcp-demo]` prefix, and the audit line is always JSON.
13. **Tab 1:** press Ctrl+C. Expect `session … closed (0 active)`, with `session=` but no `req=`, because no request is running at shutdown.

### Part 4: the debug level (12.1 step 9)

14. **Tab 1:** start the server at debug level.
    ```bash
    LOG_LEVEL=debug MCP_SERVER_PORT=4785 AUTH_REQUIRED=0 SESSION_STORE=memory pnpm start:http
    ```
15. **Tab 2:** repeat steps 5, 6 and 7 (a new session again).
16. **Tab 1:** expect one extra line, before the audit line, with the same `req` as the audit line and the final `POST /mcp 200`:
    ```
    [mcp-demo] add called with a=2, b=3 req=fd38482e session=0a049ae1-… instance=<hostname>
    ```
    Tool arguments such as latitudes, operands and file paths can be sensitive, so they print only when you ask for `debug` (decision D2).
17. **Tab 1:** press Ctrl+C.

### Part 5: a bad setting stops the server (12.1 step 10)

18. **Tab 1:** start the server with an invalid level.
    ```bash
    LOG_LEVEL=loud MCP_SERVER_PORT=4785 pnpm start:http
    ```
    Expect `Invalid configuration:` and then `- LOG_LEVEL: must be debug, info, warn or error`. The server does not stay up.
19. **Tab 1:** check the exit code. Expect `1`.
    ```bash
    echo $?
    ```

### Part 6: the Docker stack still works (12.1 step 11)

Several things outside the server's own tests read log text, and the kill test is the main one. This part shows that 12.1 did not break the messages it looks for. Docker must be running.

20. **Tab 1:** build. Skip this if you built in step 1 and changed nothing since.
    ```bash
    pnpm build
    ```
21. **Tab 1:** start the five containers (Redis, issuer, two servers and the proxy) and wait until they are healthy.
    ```bash
    docker compose -f docker/compose.scale.yml up -d --wait
    ```
22. **Tab 1:** run the kill test. Expect six `PASS` lines and `KILL TEST PASSED`.
    ```bash
    node docker/kill-test.mjs
    ```
23. **Tab 1:** remove everything, including the issuer key volume.
    ```bash
    docker compose -f docker/compose.scale.yml down -v
    ```

In Docker, `instance=` shows the container id, because the compose file does not set `INSTANCE_ID` yet. That comes in 12.2.
