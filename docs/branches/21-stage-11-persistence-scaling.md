# #21 — Stage 11: persistence and scaling (`21-stage-11-persistence-scaling`)

**Status:** in progress. Step 11.1 is built. Step 11.2 is written and tested except against a real Redis (see its section); 11.3 and 11.4 are not started. Plan: [docs/plans/stage-11-persistence-scaling.md](../plans/stage-11-persistence-scaling.md).

Stage 11 lets an HTTP session survive a restart and work across several server instances. Today a session lives in one process's memory.

## Steps at a glance

| Step | What it builds | Status |
|---|---|---|
| 11.1 | A session store interface and a spike that proves another instance can take over a session | Built |
| 11.2 | Redis store, and rebuilding a session on a store hit | Built; run against real Redis (22 tests); two-instance by hand and `403` test not done |
| 11.3 | Resumable streams (`Last-Event-ID`) | Not started |
| 11.4 | Two instances behind a proxy, kill test | Not started |

## 11.1 Session store interface

### What

- **`SessionRecord`**: the plain-data half of a session: `id`, `owner`, `state` (the `home` location), `initializeParams`, `createdAt`, `lastSeen`.
- **`SessionStore`**: `get`, `set`, `touch`, `delete`, all async, in [`src/session-store.ts`](../../packages/server/src/session-store.ts).
- **`MemorySessionStore`**: the default implementation, a `Map` in the process.
- **`http.ts`** now keeps the data in the store and only the live objects (`McpServer`, transport) in its local `sessions` map.
- **The spike**, [`test/session-rebuild.test.ts`](../../packages/server/test/session-rebuild.test.ts): a second, freshly built server and transport takes over a session id it never issued.

### Why

- A session is two things. The data is plain JSON and can go to a shared store. The live objects hold open streams and handlers and cannot be saved.
- So another instance must **rebuild** the live objects from the data. Before building the store, the plan had to know whether the SDK allows that. It does (decision D1 A).
- Splitting the data out now, with no behaviour change, keeps 11.2 small: only the store implementation changes.

### How

- **Create:** `onsessioninitialized` writes the record with `store.set(...)` and registers the live objects in `sessions`.
- **Each request:** `handleStateful` finds the live session, reads the owner from `store.get(id)` (the `403` check) and calls `store.touch(id)`, which updates `lastSeen`.
- **Close and sweep:** `transport.onclose` deletes from both. The idle sweeper reads `lastSeen` from the store.
- **The spike:** instance B is built with `sessionIdGenerator: () => storedId`, replays `initialize` and `notifications/initialized` through the public SDK API, then answers `tools/call` for the old id. No private SDK field is used. A second test shows B still answers `404` for a different id.

### Proof

- 9 new tests (2 spike, 7 store contract), 242 in total. The existing tests pass unchanged.
- **Mutation checks:** removing the replay made the spike fail, and removing `store.touch` made the idle-sweep test fail. Both were restored.

### Not done in 11.1

- **No rebuild in `http.ts`.** A store hit with no live session is still treated as missing. It is added in 11.2, because only a shared store can produce that case.
- **State is written once.** `state` is saved when the session opens. The memory store shares the same object the tools change, so it works. Redis holds a copy, so 11.2 must write `state` back after changes.
- **Protocol version** is not stored. The spike reads it from the first `initialize` reply. 11.2 must store it or derive it from `initializeParams`.

## 11.2 Redis store and rebuild

### What

- **`RedisSessionStore`** ([`src/session-store-redis.ts`](../../packages/server/src/session-store-redis.ts)): the `SessionStore` on Redis. One key per session (`mcp:session:<id>`) holding the record as JSON, with an expiry that every `set` and `touch` pushes forward.
- **Settings:** `SESSION_STORE=memory|redis` (default `memory`) and `REDIS_URL`, validated at startup in `config.ts`. `redis` without `REDIS_URL` stops the server, and no message prints the URL.
- **Rebuild:** when a request carries a session id that is in the store but not in this process, `http.ts` builds a new `McpServer` and transport, restores `state`, and replays the stored `initialize` ([`src/session-rebuild.ts`](../../packages/server/src/session-rebuild.ts)).
- **State write-back:** after each POST finishes, a changed `state` (for example `home`) is written back to the store.
- **Shutdown keeps the records:** closing the live objects on SIGTERM does not delete the records, so another instance (or this one after a restart) can take the sessions over.
- **Redis down:** at startup the server exits 1 with `Cannot reach Redis`. While running, a store failure answers `503` with `Retry-After`.

### Why

- A second instance or a restarted process has no live objects for a session id, and only the store has the data to rebuild them.
- Redis holds a copy of `state`, not the object the tools change, so without the write-back a failover would restore the `home` from when the session opened.
- Records must outlive the live objects, or a deploy would end every session.

### How

1. **Request with a session id:** read the record from the store. No record means `404`. A record with another owner means `403`, checked before any rebuild.
2. **No live session here:** `rebuildSession` builds one and replays `initialize` and `notifications/initialized`. Concurrent requests for one id share a single rebuild.
3. **Handle the request** on the live session, then `touch` the record.
4. **After a POST body finishes:** compare `state` with what was last saved, and `set` the record only if it changed.
5. **Idle sessions:** Redis expires the key. Each instance's sweeper closes live objects whose record is gone or idle.

### Proof so far

- **Run, fake client:** the Redis store's shared contract, the expiry on `set` and `touch`, and a failure becoming `StoreUnavailableError` with no leaked message. Also the new settings, the server exiting 1 when Redis cannot be reached (no URL printed), and `replayInitialize` on its own.
- **Run, real Redis 7 (Docker):** with `REDIS_URL` set, all 22 tests in `session-store-redis.test.ts` and `redis-sessions.test.ts` pass, and the full suite is 270 of 270. The two-instance tests run the real compiled server twice: a second instance answers an existing session with its `home`, a restarted server keeps it, an unknown id is `404`, and `DELETE` on one instance ends it for the other. The keys appear in Redis as `mcp:session:<id>`.
- **Break-it checks (real Redis):** with the state write-back removed, 2 two-instance tests fail. With the rebuild replaced by a `404`, 3 fail. Both were restored.
- **A bug found by running it:** the write-back used to run after the response had finished, so a client could get its answer and the server could stop before Redis had the change. A restart test failed about one run in three. The response stream now waits for the save before it closes, and 8 full runs in a row passed after the fix.
- **Not done:** a test that another caller's token gets `403` on a stored session across instances, a test for Redis going down while the server runs, and a by-hand run of two instances (steps 7 to 9 below).

### Known limits

- **Touch is not atomic:** two instances touching at once can overwrite each other's `lastSeen` by milliseconds. Two concurrent requests on one session could also let a state write undo a touch, or the reverse.
- **Three Redis round trips per request** (read, touch's read and write). Fine for this stage; a Lua script would cut it.
- **A tool call running on a dead instance is lost,** and a cancel sent to another instance does not reach it.

## New packages

| Package | Version | What it is | Why this one | Where it is used |
|---|---|---|---|---|
| `ioredis` | 6.0.0 | A Redis client for Node: it opens a connection to a Redis server and sends commands such as `GET`, `SET` and `DEL`. | Redis is a separate server, and Node has no built-in way to talk to it. We chose `ioredis` for its TypeScript types and built-in reconnect. The other common choice is the official `redis` package. | [`src/session-store-redis.ts`](../../packages/server/src/session-store-redis.ts) (`RedisSessionStore`) and the startup check in `http.ts`. Only loaded when `SESSION_STORE=redis`. |

Notes:
- **Not run against a real server yet:** I checked the types for the calls I use, but real Redis has not been run (see the 11.2 proof section).
- **Earlier packages without an explanation** (`jose` in Stage 9, `zod` in Stage 10) are not covered here. Say if you want me to add them to their stage docs.

## Try it end to end

Only the steps that exist so far. Steps for 11.2 to 11.4 are added as they are built.

1. Run the whole suite from the repo root. Expect `Tests  242 passed (242)`:
   ```bash
   pnpm test
   ```
2. Run only the new tests. Expect 9 passed:
   ```bash
   cd packages/server && npx vitest run test/session-store.test.ts test/session-rebuild.test.ts
   ```
3. Check that behaviour did not change. Start the server and connect with the CLI. It should list the tools and run `add` and `divide` as before:
   ```bash
   pnpm build
   pnpm start:http
   ```
   ```bash
   pnpm client
   ```
   The server terminal should print `session <id> opened (1 active)` and, when the client exits, `session <id> closed (0 active)`.
4. Break it on purpose, to see the spike guard something. In `test/session-rebuild.test.ts`, comment out the `await post(b.transport, { ...INIT, id: 'replay' })` line and rerun step 2. The first spike test should fail. Restore the line.

Steps 1 and 2 were run for this doc. Steps 3 and 4 were not run by hand, but they match what the tests and the earlier mutation check did.

## Try it end to end (11.2, needs Redis)

Steps 5 and 6 were run (Redis in Docker, then the real-Redis tests). Steps 7 to 9 were not run by hand.

5. Start Redis:
   ```bash
   docker run --rm -p 6379:6379 redis:7
   ```
6. Run the real-Redis tests in another terminal. Expect the 12 skipped tests to run and pass:
   ```bash
   cd packages/server && REDIS_URL=redis://localhost:6379 npx vitest run test/session-store-redis.test.ts test/redis-sessions.test.ts
   ```
7. Run two instances by hand against the same Redis. Set `SESSION_STORE=redis` and `REDIS_URL=redis://localhost:6379` in `packages/server/.env`, then start one on 4768 and one on 4770:
   ```bash
   pnpm start:http
   ```
   ```bash
   cd packages/server && MCP_SERVER_PORT=4770 node --env-file-if-exists=.env build/http.js
   ```
8. Open a session on 4768, set a home location, then call `get_home_weather` with the same `Mcp-Session-Id` on 4770. The second server's log should print `session <id> rebuilt from the store`.
9. Stop the first server with Ctrl+C and call it again on a new start: the same session id should still work.

