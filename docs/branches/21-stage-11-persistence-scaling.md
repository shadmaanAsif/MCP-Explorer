# #21 — Stage 11: persistence and scaling (`21-stage-11-persistence-scaling`)

**Status:** in progress. Step 11.1 is built. Step 11.2 is written and tested except against a real Redis (see its section); 11.3 and 11.4 are built (see their sections), waiting for your test run. Plan: [docs/plans/stage-11-persistence-scaling.md](../plans/stage-11-persistence-scaling.md).

Stage 11 lets an HTTP session survive a restart and work across several server instances. Today a session lives in one process's memory.

## Steps at a glance

| Step | What it builds | Status |
|---|---|---|
| 11.1 | A session store interface and a spike that proves another instance can take over a session | Built |
| 11.2 | Redis store, and rebuilding a session on a store hit | Built; run against real Redis (22 tests); two-instance by hand and `403` test not done |
| 11.3 | Resumable streams (`Last-Event-ID`) | Built; off by default (`RESUMABLE_STREAMS=1`); full suite passes (314 of 314 with Redis); optional debug log of stream events; a replay after the events expired is refused |
| 11.4 | Two instances behind a proxy, kill test | Built; the kill test passes with Redis and fails with the memory store; not yet run by you |

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

### Test it yourself (11.1)

1. Run the whole suite from the repo root. Expect `Tests  242 passed (242)` at the 11.1 commit. Later steps add tests, so on the current branch expect `302 passed | 20 skipped` without Redis:
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
2. **No live session here:** `rebuildSession` builds one and replays `initialize` and `notifications/initialized`. Concurrent requests for one id share a single rebuild. If there is a live session, `adoptStoredState` copies in any newer `state` another instance saved (added in 11.4, which found the need).
3. **Handle the request** on the live session, then `touch` the record.
4. **After a POST body finishes:** compare `state` with what was last saved, and `set` the record only if it changed.
5. **Idle sessions:** Redis expires the key. Each instance's sweeper closes live objects whose record is gone or idle.

### Proof so far

- **Run, fake client:** the Redis store's shared contract, the expiry on `set` and `touch`, and a failure becoming `StoreUnavailableError` with no leaked message. Also the new settings, the server exiting 1 when Redis cannot be reached (no URL printed), and `replayInitialize` on its own.
- **Run, real Redis 7 (Docker):** with `REDIS_URL` set, all 22 tests in `session-store-redis.test.ts` and `redis-sessions.test.ts` pass, and the full suite passed 270 of 270 at the time (307 of 307 after 11.3). The two-instance tests run the real compiled server twice: a second instance answers an existing session with its `home`, a restarted server keeps it, an unknown id is `404`, and `DELETE` on one instance ends it for the other. The keys appear in Redis as `mcp:session:<id>`.
- **Break-it checks (real Redis):** with the state write-back removed, 2 two-instance tests fail. With the rebuild replaced by a `404`, 3 fail. Both were restored.
- **A bug found by running it:** the write-back used to run after the response had finished, so a client could get its answer and the server could stop before Redis had the change. A restart test failed about one run in three. The response stream now waits for the save before it closes, and 8 full runs in a row passed after the fix.
- **Not done:** a test that another caller's token gets `403` on a stored session across instances, a test for Redis going down while the server runs, and a by-hand run of two instances (steps 7 to 9 below).

### Known limits

- **Touch is not atomic:** two instances touching at once can overwrite each other's `lastSeen` by milliseconds. Two concurrent requests on one session could also let a state write undo a touch, or the reverse.
- **Three Redis round trips per request** (read, touch's read and write). Fine for this stage; a Lua script would cut it.
- **A tool call running on a dead instance is lost,** and a cancel sent to another instance does not reach it.

### Test it yourself (11.2, needs Redis)

Steps 1 and 2 were run (Redis in Docker, then the real-Redis tests), and the keys in step 6 were seen in a screenshot. Steps 3 to 5 and the `PONG` check in step 1 were not run by hand.

1. Start Docker Desktop, then check the daemon is up. It should print `ok`. A `seccomp` warning above it is harmless:
   ```bash
   docker info > /dev/null && echo ok
   ```
   Start Redis in its own terminal tab. The first run downloads the `redis:7` image (roughly a hundred MB), and later runs reuse it. Wait for `Ready to accept connections`:
   ```bash
   docker run --rm -p 6379:6379 redis:7
   ```
   Check that it answers, from a second tab. It should print `PONG`:
   ```bash
   docker exec $(docker ps -q --filter ancestor=redis:7) redis-cli ping
   ```
2. Run the real-Redis tests in another terminal. Expect the 12 skipped tests to run and pass:
   ```bash
   cd packages/server && REDIS_URL=redis://localhost:6379 npx vitest run test/session-store-redis.test.ts test/redis-sessions.test.ts
   ```
3. Run two instances by hand against the same Redis. Set `SESSION_STORE=redis` and `REDIS_URL=redis://localhost:6379` in `packages/server/.env`, then start one on 4768 and one on 4770:
   ```bash
   pnpm start:http
   ```
   ```bash
   MCP_SERVER_PORT=4770 pnpm start:http
   ```
4. Open a session on 4768, set a home location, then call `get_home_weather` with the same `Mcp-Session-Id` on 4770. The second server's log should print `session <id> rebuilt from the store`.
5. Stop the first server with Ctrl+C and call it again on a new start: the same session id should still work.
6. See the saved sessions in Redis. Each session is one key, `mcp:session:<id>`, and it expires after the idle limit:
    ```bash
    docker exec $(docker ps -q --filter ancestor=redis:7) redis-cli keys 'mcp:session:*'
    ```
7. Stop Redis with Ctrl+C in its tab. `--rm` removes the container and the sessions in it. The image stays in Docker Desktop until you delete it there.

## 11.3 Resumable streams

### What

- **The problem:** a tool call that sends progress notifications (like `get_weather_batch` in [`create-server.ts`](../../packages/server/src/create-server.ts), which reports after each location) is answered over a Server-Sent Events (SSE) stream: a long-lived HTTP response that stays open and sends events one at a time, ending with the result. A normal call gets a single JSON body instead. The SDK's transport creates the stream, and our code only calls `extra.sendNotification`. If the connection drops halfway, the client loses the rest. SSE lets a client reconnect with a `Last-Event-ID` header, but only if the server kept the events and numbered them. For example, a call that sends `progress 10%`, `progress 50%`, `progress 90%` and then the final result: if the connection drops after the second event, the server still finishes, but nobody is listening for events 3 and 4. Without resumable streams the client loses the result and has to start the call again.
- **The idea:** the server saves every event it sends, with a number. After a drop, the client says "I got up to event 2, send me the rest", and the server replays events 3 and 4.
- **`EventBackend`** ([`src/event-store.ts`](../../packages/server/src/event-store.ts)): where events are kept. `MemoryEventBackend` for one process, and `RedisEventBackend` (a list per stream, plus a counter) so another instance can replay what the first one stored. Both return a sequence number (1, 2, 3…) for each event, and can return the events after a number.
- **`ScopedEventStore`:** the SDK's `EventStore` for one session. It builds ids as `<sessionId>~<streamId>~<number>`, and replays the events after a given id.
- **Settings** (validated at startup): `RESUMABLE_STREAMS` (`0` or `1`, default `0`), `EVENT_STORE_MAX_EVENTS` (default 500 per stream) and `EVENT_STORE_TTL_MS` (default 300000, five minutes).
- **Off by default,** because turning it on makes the server send an extra empty "priming" event with an id at the start of each stream, which the server never did before. The priming event gives the client an id to resume from even if the connection drops before the first real event. It changes what clients see, so you turn it on explicitly with `RESUMABLE_STREAMS=1`.
- **`EVENT_STORE_DEBUG`** (`0` or `1`, default `0`): prints one server log line each time an event is stored or replayed. The `ScopedEventStore` takes an optional `log` function and calls it at each of those points. With the setting off no function is passed, so nothing is printed. Lines show the method name or progress count (`progress 2/3`), never the content, because the content can hold what the user asked for.

### Why

- A rebuilt or second instance (11.2) can answer a session, but a stream that dropped mid-call would still lose its messages. Storing events in the same Redis closes that gap.
- **The session id is inside the event id on purpose.** The SDK's own example store is not safe to copy here: it splits ids on `_`, which breaks the standalone stream id `_GET_stream`, and it is not scoped to a session. In our store, one session cannot replay another's events even though the standalone stream has the same name in every session.
- **Bounded:** each stream keeps at most `EVENT_STORE_MAX_EVENTS` events and expires after `EVENT_STORE_TTL_MS`, so storage cannot grow without limit.

### How

1. A client opens a stream (for example a `get_weather_batch` call with a progress token). Each message sent on it is saved with `append`, and the SSE event carries the id.
2. The connection drops. The client reconnects with `GET /mcp`, the same `Mcp-Session-Id`, and `Last-Event-ID` set to the last id it saw.
3. The server (any instance, with Redis) checks that the id belongs to this session, then sends every stored event after that number, oldest first, and keeps the stream open for new ones.
4. If older events were already dropped (cap or expiry, including all of them), the server refuses the replay with an error instead of silently skipping messages. A client that already had every event gets `200` and nothing to replay.

**Example, step by step** (ids shortened; a real id is `<sessionId>~<streamId>~<number>`):

1. The client calls a long tool. The server opens a stream and sends events with ids, saving each one in the event store:
    ```
    id: abc123~s1~1   progress 10%
    id: abc123~s1~2   progress 50%
    ```
2. The connection drops. The server finishes anyway and saves `abc123~s1~3` (progress 90%) and `abc123~s1~4` (the final result). It has nowhere to send them.
3. The client reconnects:
    ```
    GET /mcp
    Mcp-Session-Id: abc123
    Last-Event-ID: abc123~s1~2
    ```
4. The server checks that the id belongs to session `abc123` and stream `s1`.
5. The server replays events 3 and 4, and the client gets its result.

**Reading the flow in the server log** (`RESUMABLE_STREAMS=1` and `EVENT_STORE_DEBUG=1`). The log shows the same example as it happens. This is real output from a `get_weather_batch` call for three places, with the session id shortened to `<S>` and the stream id to `<stream>`:

```
[mcp-demo] event stored <S>~<stream>~1 (priming event)
[mcp-demo] event stored <S>~<stream>~2 (progress 1/3)
[mcp-demo] event stored <S>~<stream>~3 (progress 2/3)
[mcp-demo] event stored <S>~<stream>~4 (progress 3/3)
[mcp-demo] event stored <S>~<stream>~5 (result)
        ... connection drops, client reconnects with Last-Event-ID ...~2 ...
[mcp-demo] replay requested after <S>~<stream>~2
[mcp-demo] replay sent <S>~<stream>~3 (progress 2/3)
[mcp-demo] replay sent <S>~<stream>~4 (progress 3/3)
[mcp-demo] replay sent <S>~<stream>~5 (result)
[mcp-demo] replay done: 3 event(s) after <S>~<stream>~2
[mcp-demo] GET /mcp 200 1ms
```

| Log line | Flow step |
|---|---|
| `event stored …~N (what)` | Step 1 and 2: each message is saved before it is sent, and the number is the one on the SSE `id:` line. It is printed whether or not anyone is still connected. |
| `replay requested after …~2` | Step 3: the client reconnected and the id passed the session check. |
| `replay sent …~N (what)` | Step 5: one line per event sent again. The priming event is skipped. |
| `replay done: N event(s)` | The replay finished. `0 event(s)` means the client had already seen everything. |
| `replay refused: the event id is not from this session` | "What can go wrong", first bullet. It comes with a `400`. The id is not printed, because the client wrote it. |
| `replay refused: events after … are no longer stored` | "What can go wrong", second bullet: the cap or the expiry dropped some of the events, or all of them. |

The `POST /mcp 200 …ms` line that closes a call is the existing request log from `http.ts`. It appears when the stream ends, not per event.

**What can go wrong:**

- **The id belongs to another session:** the request is rejected with `400`, so one client cannot read another's events.
- **Older events were already dropped:** the store keeps at most `EVENT_STORE_MAX_EVENTS` events for `EVENT_STORE_TTL_MS`. If the client reconnects after some were dropped, or after all of them expired, the server refuses the replay instead of sending a stream with a gap. The SDK turns the refusal into `HTTP 500` with `Error replaying events`, and the log says `replay refused: events after … are no longer stored`.
    - **How it can tell "expired" from "nothing newer":** the counter that numbers the events (`mcp:events:<session>~<stream>:seq` in Redis) is kept 6 times as long as the events, which is 30 minutes at the defaults. If the events are gone but the counter is higher than the client's number, events existed and were lost. If the counter equals the client's number, the client had everything, and it gets `200` with nothing to replay.
    - **After the counter expires too:** the stream is forgotten. A replay then returns `200` with 0 events, the same as for a stream that never existed, because nothing is left to compare with.
- **The setting is off:** no ids are sent, so there is nothing to resume from.

### Proof

- **Unit tests** (`event-store.test.ts`): a shared contract for the memory backend, the Redis backend with a fake client and real Redis, plus the cap, the expiry, the sweep of old streams, failures turning into `StoreUnavailableError` with no leaked message, ids with underscores, another session's ids refused, malformed ids refused, and the error when events were dropped. The expiry tests cover the counter outliving the events (memory and Redis), a replay refused when all the events expired (memory, and Redis with a fake client that drops the list), a client that is up to date accepted, and the refusal log line. All 38 pass with `REDIS_URL` set, including the two debug-log tests.
- **End-to-end tests** (`resumable-streams.test.ts`, the real compiled server): after a 3-location batch, reconnecting with the id of the first progress event returns exactly `progress 2`, `progress 3` and the result, with the same ids. Reconnecting with the last id returns nothing. Another session's id gets `400`. With the setting off no ids are sent. With Redis, a second instance replays what the first stored. 4 pass without Redis, 5 with it.
- **Break-it checks:** with the event store not passed to the transport, 3 end-to-end tests failed. With the session check removed, the "another session's ids" test failed. With the new "all events expired" check removed, 3 of the new tests failed. All were restored.
- **Debug log by hand:** I started a temporary server with `RESUMABLE_STREAMS=1 EVENT_STORE_DEBUG=1` and ran a 3-location batch, then reconnected after `~2`. The log printed the five `event stored` lines, then `replay requested`, three `replay sent` lines and `replay done: 3 event(s)`, as shown above. Another session's id printed the `refused` line and got `400`. The server was stopped afterwards.
- **Late replay by hand (real Redis):** I started a temporary server on port 4784 with `RESUMABLE_STREAMS=1`, `EVENT_STORE_DEBUG=1` and `EVENT_STORE_TTL_MS=2000`, ran a 3-location batch, and replayed after `~2`: `200`, 3 events. After 3 seconds the list key was gone. The same replay then got `HTTP 500` with `Error replaying events` and the log line `replay refused: events after …~2 are no longer stored`. A replay after `~5` got `200` and `replay done: 0 event(s)`. Before the fix, a replay after the expiry returned `200` with 0 events, which is what repeated replays showed in a hand test on 4768. The server was stopped afterwards.
- **Config tests:** 17 pass, including the four new settings.
- **Full suite:** 295 passed and 19 skipped without Redis, and 314 of 314 with real Redis. Earlier full runs stalled on this machine, and a test that normally takes a second showed about 1000 seconds. The wall clock was jumping 15 minutes across a 5-second sleep with a load average of 70, so I put it down to the machine and not the code. The same test passed in 3 seconds afterwards.

### Known limits

- **Events are in memory when sessions are:** with the memory store, a restart loses them. Only Redis keeps them across restarts and instances.
- **Not cleaned on session end:** events expire by their time limit, not when the session is deleted. The counter key stays up to 30 minutes at the defaults, one small number per stream.
- **A refused replay is `HTTP 500`.** That is how the SDK reports any error thrown while replaying. The log line is the clearer signal. I did not change the SDK's status code.
- **Not tried:** a real client that reconnects by itself. The tests send the `GET` by hand. I have not tried Cursor or the SDK client on a dropped connection.
- **The priming event needs the protocol header.** Without `Mcp-Protocol-Version: 2025-11-25` on the request, my `curl` call got no priming event and numbering started at the first progress event. With the header, the priming event is `~1`. I saw both, but I did not read the SDK code to say exactly which version check decides it. Real clients send the header.
- **The debug log is per instance.** Each instance prints only the events it stored or replayed itself. With two instances you read two logs.
- **Two writers on one stream** could store events slightly out of order. A stream is only written by the instance that holds its live session, so I do not expect it, and replay sorts by number.

### Test it yourself (11.3)

Test these yourself before the 11.3 commit. Steps 1 to 3 were run by the assistant (tests only). Steps 4 and 5 were run by the assistant with `curl` on a temporary server (port 4780, memory store), and by you in the Inspector and Postman against servers on 4768 and 4770 with auth on, including a replay on the other instance than the one that stored the events. Step 6 was run by the assistant on two temporary servers (ports 4782 and 4783, `curl`, auth off), and you checked that Redis had no `mcp:events:*` keys with `RESUMABLE_STREAMS=0`. Step 7 was run by the assistant with `curl` on a temporary server (port 4784, real Redis), not through `.env`. You have not run step 7.

1. Run the unit and end-to-end tests without Redis. Expect the Redis-only ones to be skipped:
    ```bash
    cd packages/server && npx vitest run test/event-store.test.ts test/resumable-streams.test.ts
    ```
2. Run them again with Redis running (11.2, step 1). Expect everything to pass, including a second instance replaying the first one's events:
    ```bash
    cd packages/server && REDIS_URL=redis://localhost:6379 npx vitest run test/event-store.test.ts test/resumable-streams.test.ts
    ```
3. Run the whole suite with Redis running. Expect `Tests  322 passed (322)` (it was 314 before 11.4 added 8 tests):
    ```bash
    REDIS_URL=redis://localhost:6379 pnpm test
    ```
4. Try it by hand. In `packages/server/.env` set `RESUMABLE_STREAMS=1` and `EVENT_STORE_DEBUG=1`, restart `pnpm start:http`, then open a session and run a `get_weather_batch` call with a `progressToken` and `-H 'Mcp-Protocol-Version: 2025-11-25'`, as the test does. Every event in the stream should carry an `id:` line such as `<session>~<stream>~3`. In the terminal running the server, expect one `event stored <session>~<stream>~N (...)` line per event: `priming event`, `progress 1/3`, `progress 2/3`, `progress 3/3`, then `result`.
5. Reconnect with the id of the first progress event. You should receive the later events:
    ```bash
    curl -N localhost:4768/mcp -H 'Accept: text/event-stream' -H 'Mcp-Session-Id: <id>' \
      -H 'Mcp-Protocol-Version: 2025-11-25' -H 'Last-Event-ID: <session>~<stream>~2'
    ```
    If your `.env` has `AUTH_REQUIRED=1`, add `-H "Authorization: Bearer $MCP_TOKEN"` to this request and to the calls in step 4. Make the token with `export MCP_TOKEN=$(pnpm --silent issuer token --sub alice --scope "mcp:tools weather:use")`, with the issuer running (`pnpm issuer serve`).
    Press Ctrl+C when it has printed them. The stream stays open for new events, so `curl` does not exit on its own. In the server terminal, expect `replay requested after …~2`, three `replay sent` lines (`progress 2/3`, `progress 3/3` and `result`) and `replay done: 3 event(s)`. Then change the id's session part to something else and run it again: expect `400` from `curl` and `replay refused: the event id is not from this session` in the server log.
6. Check that it is off by default. Set `RESUMABLE_STREAMS=0` (or remove it), restart `pnpm start:http`, and repeat step 4. The events should carry no `id:` line and the log should show no `event stored` lines. Then set `RESUMABLE_STREAMS=1` with `EVENT_STORE_DEBUG=0` and repeat: the `id:` lines come back, but the server log stays quiet.
7. Check that a late replay is refused. In `packages/server/.env` set `RESUMABLE_STREAMS=1`, `EVENT_STORE_DEBUG=1` and `EVENT_STORE_TTL_MS=10000`, restart `pnpm start:http`, and run a `get_weather_batch` call as in step 4. Wait 11 seconds, then send the step 5 request with `Last-Event-ID` set to the `~2` id. Expect `HTTP 500` with `Error replaying events`, and `replay refused: events after …~2 are no longer stored` in the server log. Then send it again with the `~5` id: expect `200`, no events, and `replay done: 0 event(s)`. Remove the `EVENT_STORE_TTL_MS` line afterwards.

## 11.4 Two instances behind a proxy

### What

- **The problem:** 11.1 to 11.3 let a session live outside one process, but so far only tests have shown it. 11.4 runs the real thing: several processes, one Redis, and a proxy in front, and then kills the instance that holds a session.
- **[`docker/compose.scale.yml`](../../docker/compose.scale.yml):** one `docker compose` file that starts five containers: `redis`, `issuer`, `server-a`, `server-b` and `proxy`. Both servers run the same compiled code from this repo with `SESSION_STORE=redis`, `RESUMABLE_STREAMS=1` and `AUTH_REQUIRED=1`, and check every token against the `issuer` service.
- **[`docker/proxy.conf`](../../docker/proxy.conf):** an nginx config that sends each request to `server-a` or `server-b` in turn, listening on host port `4790`.
- **A fix the kill test forced, in [`src/session-rebuild.ts`](../../packages/server/src/session-rebuild.ts) and [`src/http.ts`](../../packages/server/src/http.ts):** `adoptStoredState` makes a live session pick up a `state` another instance saved. See Proof.
- **[`docker/kill-test.mjs`](../../docker/kill-test.mjs):** a plain Node script (no dependencies) that gets a token from the issuer, runs the kill test against the stack and prints `PASS` or `FAIL` for each check.

### Why

- **A proxy is how a client sees "one server".** Clients connect to one address (`localhost:4790`) and never learn which instance answered. That is what makes losing an instance survivable: the proxy tries the other one, and the session store (11.2) lets it answer.
- **`proxy_buffering off` is the one setting that matters for MCP.** With nginx's default, SSE events are held back until a buffer fills, so progress messages arrive late or all at once. The config also sets a long `proxy_read_timeout`, because a stream can be quiet for a while.
- **No Dockerfile on purpose.** The containers use the stock `node:24.22.2-alpine` image (the same Node version CI pins) and run the repo's `build/` folder through a read-only mount. Packaging the server for production belongs to Stage 13. The cost is that you must run `pnpm build` first.
- **Redis and the issuer have no published port,** so they cannot clash with a Redis on `6379` or an issuer on `4769` that you already run (see 11.2).
- **Auth is on, and the issuer is its own service.** Two instances behind a proxy only make sense if both accept the same token, and the owner check from 11.2 (`403` for another user's session) needs a real `sub` in the token. See "Why the issuer is a separate service" below.

### Docker words used here

If Docker is new to you, these six words cover this section.

| Word | Plain meaning |
|---|---|
| **Image** | A packaged, read-only snapshot of a program and what it needs. `node:24.22.2-alpine` is Node 24.22.2 on a very small Linux. |
| **Container** | A running copy of an image, like a small separate computer. It is gone when removed. |
| **Mount** (`volumes:` with a path) | A folder from your Mac shown inside a container. `:ro` means the container can only read it. |
| **Volume** (`volumes:` with a name) | Storage Docker keeps for you, which outlives a container. `docker compose down` keeps it, `down -v` deletes it. |
| **Port mapping** | `4790:80` means host port 4790 goes to port 80 inside that container. A container's ports are invisible to your Mac unless you map them. |
| **Compose** | One file that starts several containers together. They share a private network, and each reaches the others by its service name, such as `redis` or `server-a`. |

### Docker commands used here

Every command is `docker compose -f docker/compose.scale.yml <what>`. The `-f` points at this stack's file, so run them from the repo root.

| Command | What it does |
|---|---|
| `up -d --wait` | Start all five containers in the background and wait until the ones with a health check are healthy. |
| `ps` | List the containers, their state and their published ports. |
| `logs server-a server-b issuer` | Print what those containers wrote. Add `-f` to keep following it. |
| `stop server-a` | Stop one container, as the kill test does. Redis is untouched. |
| `start server-a` | Start a stopped container again. |
| `exec -T issuer <command>` | Run a command inside a running container. `-T` turns off the terminal, which you need when you pipe or copy the output. |
| `down` | Stop and remove all containers and the network. Named volumes stay. |
| `down -v` | The same, and delete the named volume, which is the issuer's signing key. |

### compose.scale.yml, piece by piece

| Piece | What it does |
|---|---|
| `x-server: &server` | A reusable block of settings named `server`. `server-a` and `server-b` both say `<<: *server`, which copies the whole block, so they are the same server run twice. |
| `image: node:24.22.2-alpine` | Which image the container is made from. It is the Node patch version CI pins. |
| `volumes: - ..:/app:ro` | Mounts the repo root (`..` is the folder above `docker/`) at `/app`, read-only. This is why there is no Dockerfile: the containers run the `build/` folder you built on your Mac, so run `pnpm build` first. |
| `command: node packages/server/build/http.js` | What the container runs. There is no `--env-file`, so your `packages/server/.env` is ignored and the settings below are the only ones. |
| `environment:` | The server's settings, the same names as in `.env`. `SESSION_STORE=redis` and `REDIS_URL=redis://redis:6379` point at the `redis` container by its service name. |
| `MCP_SERVER_URL: http://localhost:4790/mcp` | The address clients use, which is the proxy. It is also the audience a token must carry. |
| `ISSUER_URL: http://issuer:4769` | Where the servers fetch the issuer's public key, and the `iss` they expect in a token. |
| `depends_on: ... service_healthy` | Start a server only after Redis and the issuer answer their health checks. |
| `redis` `healthcheck` | Runs `redis-cli ping` every 2 seconds. Compose treats the container as ready once it answers. |
| `issuer` | The token issuer (see the next section). Its key is stored in the named volume `issuer-keys`, mounted at `/keys`, because the repo mount is read-only. |
| `proxy` `ports: "4790:80"` | The only published port. Your Mac reaches the whole stack through `localhost:4790`. |
| `proxy` `volumes: ./proxy.conf:/etc/nginx/conf.d/default.conf:ro` | Puts `proxy.conf` where nginx reads its settings. |

Both servers listen on `4768` inside their own containers. That does not clash with a server you run on your Mac, because the containers' ports are not published.

### proxy.conf, piece by piece

A proxy sits in front of servers: the client talks to the proxy, and the proxy passes each request to one of them. nginx is the proxy program, and this file is its settings.

| Setting | What it does |
|---|---|
| `upstream mcp_servers { server server-a:4768 ...; server server-b:4768 ...; }` | A named group of two servers. nginx rotates through them in turn (round-robin). |
| `max_fails=1 fail_timeout=5s` | After one failed attempt, nginx skips that server for 5 seconds. |
| `listen 80` | Listen on port 80 inside the container, which is host port 4790. |
| `proxy_pass http://mcp_servers` | Forward every URL to the group. |
| `proxy_http_version 1.1` and `proxy_set_header Connection ""` | Allow long-lived connections to the servers, which streams need. |
| `proxy_buffering off` | The setting that matters for MCP. By default nginx collects a response and sends it in chunks, which would hold SSE progress events back until the end. |
| `proxy_read_timeout 1h` | A stream can be quiet for a long time. The default is 60 seconds. |
| `proxy_connect_timeout 2s` and `proxy_next_upstream error timeout` | If a server refuses or does not answer within 2 seconds, try the other one. This is the failover in the kill test. |

TLS, auth and routing rules are not here. They are Stage 13's gateway work.

### How the compose file connects to the proxy

The two files do different jobs. `compose.scale.yml` starts the proxy container and gives it its settings file and a port. `proxy.conf` says where nginx forwards requests. There are three links between them:

| Link | In `compose.scale.yml` | What it does |
|---|---|---|
| Port | `ports: "4790:80"` | Host port 4790 goes to port 80 inside the proxy container. This is why `curl localhost:4790` reaches nginx. |
| Settings file | `volumes: ./proxy.conf:/etc/nginx/conf.d/default.conf:ro` | Shows `proxy.conf` to nginx at the place it reads its settings. This is the only link between the two files. |
| Start order | `depends_on: [server-a, server-b]` | Start the proxy after the servers. |

Then `proxy.conf` sends each request on: its `upstream` block lists `server-a:4768` and `server-b:4768`, and `proxy_pass http://mcp_servers` forwards to one of them. Those names are the service names in the compose file. Compose puts every container on one private network where each service name resolves to that container, which is how nginx finds the servers. The compose file never mentions the forwarding rules, and `proxy.conf` never mentions a port on your Mac.

```
Mac :4790 → proxy container :80 → (proxy.conf) → server-a:4768 or server-b:4768
```

**Both files sit in the same folder, `docker/`, on purpose.** In a `volumes:` entry the part before the colon is a path on your Mac and the part after it is a path inside the container. A relative path on the Mac side, such as `./proxy.conf` or `..`, is resolved from the folder that holds the compose file, not from the folder you run the command in:
- `./proxy.conf` means `docker/proxy.conf`, the file next to `compose.scale.yml`.
- `..` means the repo root, the folder above `docker/`. That is the `..:/app:ro` mount the servers use.

Checked: `docker compose -f docker/compose.scale.yml config` printed the proxy mount's source as `<repo>/docker/proxy.conf` and the server mounts' source as `<repo>`. Running it from another folder printed the same paths. So the stack works wherever you run the command from. If you move `proxy.conf` out of `docker/`, change its path in the compose file too. I haven't tried what Docker does when the path is wrong.

A request flows like this: `curl localhost:4790/mcp` reaches the proxy container, nginx picks `server-a` or `server-b`, and that server verifies the token (using the issuer's key) and reads or writes the session record in Redis. Because the record is in Redis, either server can answer.

### Why the issuer is a separate service

- **It already is a separate process.** The issuer has its own port (`4769`) and its own signing key, and it never calls the servers. The servers know it only by URL (`ISSUER_URL`). They fetch its public key from `/jwks.json` once, cache it, and check each token's signature, issuer, audience and expiry. Nothing is shared between instances, so any instance accepts any valid token. That is why tokens do not get in the way of scaling.
- **Folding it into a server would be wrong.** If the issuer ran inside `server-a`, stopping `server-a` would also stop the issuer, and two servers would each have their own key, so a token from one would fail on the other. One issuer with one key, shared only as a URL, is the shape of a real identity provider such as Auth0 or Keycloak. The compose file models that.
- **How it is wired.** Two pairs of settings have to agree:
    - `ISSUER_URL` is `http://issuer:4769` on the servers and on the issuer. The issuer writes it into each token as `iss`, and the servers expect that exact string.
    - `MCP_SERVER_URL` on the servers and `TOKEN_AUDIENCE` on the issuer are both `http://localhost:4790/mcp`. The issuer writes it into each token as `aud`, and the servers expect it.
- **The signing key** is made on first start and kept in the named volume `issuer-keys`. `docker compose down` keeps it, so old tokens still verify after a restart. `down -v` deletes it, and the next start makes a new key.
- **A health check on `/jwks.json`,** so the servers start only after the issuer can answer.
- **Not published to the host,** so it cannot clash with an issuer you run on `4769`. You get a token with `docker compose exec` (see "How a token is issued" below).

### How a token is issued

There is no login page and no token endpoint. A token comes from one command, run inside the `issuer` container:

1. **The key.** The issuer makes its signing key the first time it starts and keeps it in the `issuer-keys` volume.
2. **The command.** `issuer-cli.js token` signs a token with that key, prints it and exits. The token carries `iss` `http://issuer:4769`, `aud` `http://localhost:4790/mcp`, `sub` set to the name you give (here `alice`) and the scopes you ask for. It lasts 3600 seconds.
3. **The request.** You send it as `Authorization: Bearer <token>` to `localhost:4790`.
4. **The check.** Whichever server gets the request verifies the signature with the public key from `/jwks.json`, then `iss`, `aud`, expiry and the scope for that tool. It never calls the issuer per request.

Two things follow from this:

- **Send it to the proxy,** `localhost:4790`. The audience is that address, so a token from this issuer is not valid for a server you run yourself on `4768`, and a token from your own issuer on `4769` is not valid here.
- **Because there is no token endpoint,** a client that tries to find the issuer and log in by itself has nothing to talk to. See Known limits.

Checked: a token made this way decoded to the claims above with about 3599 seconds left, and `initialize` with it through the proxy returned `200`. With no token the same request returned `401`. How to copy it for Postman or the Inspector is step 9 of "Test it yourself (11.4)".

### How

The kill test, step by step:

0. Get a token for `alice` from the `issuer` service with `docker compose exec`. Every request below sends it as `Authorization: Bearer <token>`.
1. Open a session through the proxy (`initialize`). One instance answers and writes the session record to Redis.
2. Call `set_home_location` with Dubai. The state is saved to Redis after the call (11.2).
3. Find which instance holds the session by looking in the two containers' logs for `session <id> opened`. Call it the owner.
4. Make sure the other instance (the survivor) starts cold. The proxy alternates between instances, so the survivor has usually built its own live copy of the session by now (its log has `session <id> rebuilt from the store`). Then the failover would not need Redis. If it holds a copy, `docker compose restart` it: that drops the live copy and keeps the record in Redis. Then count the survivor's `rebuilt from the store` lines for this session.
5. `docker compose stop` the owner.
6. Call `get_home_weather` with the same session id through the proxy. The proxy cannot reach the dead instance (2 second connect timeout), so it tries the other one. That instance has no live session, finds the record in Redis, rebuilds the session and answers with the Dubai weather.
7. Check that the survivor logged one more `session <id> rebuilt from the store` than before the stop, so the rebuild happened after the owner died.
8. Call with a made-up session id and expect `404`.
9. Start the stopped instance again, wait until it listens and nginx has stopped skipping it (6 more seconds), so the test can be run again straight away.

### Proof

- **A state bug, found by the kill test and fixed.** `handleStateful` reused a live session without reloading its `state` from the record, even though it reads the record on every request. Behind a proxy that rotates, one session's first requests reach both instances, so each builds a live copy. After a state change on one, the other kept answering from its old copy. The kill test then passed or failed depending on routing: it failed twice running with `No home location set in this session`, and passed twice, and once more with auth on.
    - **Fix:** `adoptStoredState` in [`session-rebuild.ts`](../../packages/server/src/session-rebuild.ts), called from `handleStateful` when a live session already exists. When the record's state differs from what this instance last loaded or saved, it copies the record's state into the live `state` object. It copies in place, because the tools hold a reference to that object. It does nothing when this instance has a change of its own that is not written back yet. Two overlapping requests on different instances are last writer wins. The log line is `session <id> state refreshed from the store`.
    - **Tests:** 7 unit tests in [`session-state-refresh.test.ts`](../../packages/server/test/session-state-refresh.test.ts), and a two-instance test in [`redis-sessions.test.ts`](../../packages/server/test/redis-sessions.test.ts) with two real servers and real Redis (set on A, read on B, set on B, read on A, set on A, read on B). With the refresh switched off, the two-instance test fails with `Dubai` where `Paris` was expected, which is the kill test's failure.
    - **Suite:** 302 passed and 20 skipped without Redis, and 322 of 322 with Redis.
    - **Kill test after the fix:** 5 of 6 consecutive runs passed. The sixth failed with `502` from the proxy, not with the state bug (see Known limits). After the script learned to wait when it restarts the owner, 8 of 8 back-to-back runs passed. Across those 14 runs `server-b` logged `state refreshed from the store` twice, so the stale-copy path was hit for real and the answer was still correct.
- **The rebuild check was too weak, and is now strict.** It used to look in the survivor's whole log for `rebuilt from the store`. In a run I read by timestamp, `server-b` had built its own copy 53 ms after `server-a` opened the session, 0.2 seconds before `server-a` was stopped, and answered after the kill from that copy. The test passed, but no rebuild happened after the kill. The script now restarts a survivor that holds a copy, then requires one more `rebuilt` line after the stop. The log of the first run with the new script shows the order: `server-b` rebuilt at 11:54:11.67, was shut down for its restart at :12.05, `server-a` was stopped at :13.17, and `server-b` rebuilt again at :15.36.
    - **Break-it check:** a copy of the script with the restart step removed failed on that check (`FAIL  server-b rebuilt the session from Redis after server-a died`) and passed the others.
    - **Runs:** 4 of 4 runs with the new script passed. In all 4 the survivor already held a copy, so the restart step ran every time. I have not seen the case where the survivor starts cold without it, so that branch of the script is untested.
- **Auth across two instances (checked by hand):** with the issuer service up, a request with no token and one with a made-up token both got `401` through the proxy, and the kill test's token (`sub` `alice`) was accepted by both instances. The audit log on `server-b` shows `"sub":"alice"` for the session `server-a` opened.
- **Break-it check:** with `SESSION_STORE=memory` in the compose file, the kill test failed with `HTTP 404` after the owner was stopped, because the survivor had no record of the session. The file was restored to `redis`. The first version of the script also crashed on that 404 (the body is JSON, not SSE), so I fixed it to print a `FAIL` line instead.
- **No SSE buffering:** a 5-location `get_weather_batch` through the proxy delivered its progress events about 140 ms apart (`+547`, `+681`, `+823`, `+960`, `+1095` ms) and the result right after, not all at the end.
- **Not covered by a test:** the compose file and script are checked by running them. There is no automated test in `pnpm test`, because it needs Docker.

### Known limits

- **After a stop and start, the proxy can have no usable server for up to 5 seconds.** In 1 of 6 back-to-back kill test runs the call after the kill got `502`. The proxy log shows `upstream timed out while connecting`, `upstream server temporarily disabled` and `no live upstreams`. `max_fails=1 fail_timeout=5s` takes a server out of the rotation for 5 seconds after one failed attempt, so a server that was just stopped and restarted is skipped while the other one is dead. The containers' IPs did not change. I have not reproduced it on purpose. A client that retries after a moment gets through, and the kill test waits after it restarts the owner so the next run starts clean.
- **The issuer is not reachable from the host,** on purpose. The servers' metadata (`/.well-known/oauth-protected-resource/mcp`) therefore advertises `http://issuer:4769`, a name only the containers can resolve. I expect a client that discovers the issuer by itself to fail here, but I have not tried one. Use a token you made with `docker compose exec`, as the kill test does.
- **A call running on the killed instance is lost.** The test stops the owner while it is idle. A tool call that was mid-run when the instance died dies with it, and resumable streams (11.3) can only replay events that were already stored. The client calls again.
- **Not tried through the proxy:** replaying a stream with `Last-Event-ID` on the other instance. The tests do it with two servers and Redis, but not behind nginx.
- **Round-robin, no stickiness.** That is the point (any instance can answer), but it also means rate limits are per instance (decision D5 in the plan): two instances allow twice the rate.
- **nginx looks up the instance names once, at startup.** Stopping and starting a container worked in my runs. Recreating one, which can change its IP, may need the proxy restarted. I have not tried that.
- **The proxy is a single point of failure,** and it has no TLS or auth. That is Stage 13.
- **The mount is the host's `node_modules`,** which works here because the dependencies are plain JavaScript. A package with a native build would need a real image.

### Test it yourself (11.4, needs Docker)

Test these yourself before the 11.4 commit, in a terminal on Node 24 (`nvm use 24.22.2`), from the repo root. They run in order: first the automated tests for the state fix (steps 1 to 4), then the Docker stack (steps 5 to 13).

Run by the assistant: steps 1 to 8 and 10 and 13, and the token command in step 9. Not run by hand: the clipboard commands in step 9, and steps 11 and 12. The kill test in step 10 passed 13 of 14 runs for the assistant, and the one failure was the 5-second proxy window described in Known limits. After the rebuild check was made strict, it passed 4 of 4 runs.

1. Build the server, because the tests and the containers run `packages/server/build`:
    ```bash
    pnpm build
    ```
    `pnpm build` failed in `packages/web` twice for the assistant and passed when `packages/web` was built alone. I did not find the cause. If it fails there, run it again.
2. Run the unit tests for the state fix. They need no Redis. Expect `Tests  7 passed (7)`:
    ```bash
    pnpm exec vitest run packages/server/test/session-state-refresh.test.ts
    ```
3. Start a Redis for the next step. Skip this if the Redis from 11.2 is still running (`docker ps` shows `redis:7` on `6379`):
    ```bash
    docker run --rm -d --name mcp-test-redis -p 6379:6379 redis:7
    ```
4. Run the two-instance test against real Redis. It starts two real servers on one Redis, saves a different `home` on each in turn, and checks that the other answers with the new one. Expect `Tests  5 passed (5)`:
    ```bash
    REDIS_URL=redis://localhost:6379 pnpm exec vitest run packages/server/test/redis-sessions.test.ts
    ```
5. Start the Docker stack and wait until it is healthy. The first run pulls `node:24.22.2-alpine` and `nginx:alpine`:
    ```bash
    docker compose -f docker/compose.scale.yml up -d --wait
    ```
6. List the containers. Expect five: `redis` and `issuer` (healthy), `server-a`, `server-b`, and `proxy` with `0.0.0.0:4790->80/tcp`:
    ```bash
    docker compose -f docker/compose.scale.yml ps
    ```
7. Read the logs. Expect `Token issuer on http://issuer:4769 (keys: /keys/issuer-key.json)` once and `mcp-demo server running on http://localhost:4768/mcp (stateful)` twice:
    ```bash
    docker compose -f docker/compose.scale.yml logs --no-log-prefix issuer server-a server-b
    ```
8. Check that auth is on. A request with no token must be refused. Expect `401`:
    ```bash
    curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4790/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{}'
    ```
9. Get a token. It comes from the issuer container (see "How a token is issued"). Pick the form you need:
    - **For `curl` in this terminal,** keep it in a variable. Check that it is not empty, it should print about 600:
        ```bash
        TOKEN=$(docker compose -f docker/compose.scale.yml exec -T issuer node packages/server/build/auth/issuer-cli.js token --sub alice --scope "mcp:tools weather:use"); echo ${#TOKEN}
        ```
    - **To copy the token itself,** put it on the clipboard:
        ```bash
        docker compose -f docker/compose.scale.yml exec -T issuer node packages/server/build/auth/issuer-cli.js token --sub alice --scope "mcp:tools weather:use" | pbcopy
        ```
    - **To copy a header value for Postman or the Inspector,** copy it with the `Bearer ` prefix, then paste it as the value of an `Authorization` header and use `http://localhost:4790/mcp` as the URL:
        ```bash
        printf 'Bearer %s' "$TOKEN" | pbcopy
        ```
    The token lasts an hour. Make a new one when it expires.
10. Run the kill test. It gets its own token. Expect six `PASS` lines and `KILL TEST PASSED`. The `stopping` line names the instance that held the session, and `rebuilt the session from Redis after … died` names the other one. A line `… already holds a live copy of the session; restarting it so it starts cold` usually appears before `stopping`: that is expected, and it makes the run take a few seconds longer. It ends with at least 6 seconds of waiting, because it restarts the stopped instance and lets the proxy stop skipping it. Run it more than once if you like: it leaves the stack ready for the next run.
    ```bash
    node docker/kill-test.mjs
    ```
11. Do the same by hand. This needs `TOKEN` from step 9. First set the headers, then open a session and keep its id:
    ```bash
    H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Mcp-Protocol-Version: 2025-11-25')
    ```
    ```bash
    SID=$(curl -si localhost:4790/mcp "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r'); echo $SID
    ```
    Finish the handshake, then set the home location:
    ```bash
    curl -s localhost:4790/mcp "${H[@]}" -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    ```
    ```bash
    curl -s localhost:4790/mcp "${H[@]}" -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"set_home_location","arguments":{"name":"Dubai","latitude":25.2,"longitude":55.27}}}'
    ```
    Expect `Home location set to Dubai` in the reply. Find the instance that holds the session. The line starts with its name:
    ```bash
    docker compose -f docker/compose.scale.yml logs server-a server-b | grep "session $SID opened"
    ```
    Stop that instance. Use `server-b` if the line above started with `server-b`:
    ```bash
    docker compose -f docker/compose.scale.yml stop server-a
    ```
    Ask for the weather with the same session id. The first call can take about 2 seconds, which is the proxy's connect timeout on the dead instance. Expect the Dubai weather:
    ```bash
    curl -s localhost:4790/mcp "${H[@]}" -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_home_weather","arguments":{}}}'
    ```
    Check that the other instance took the session over. Expect a `rebuilt from the store` line, or a `state refreshed from the store` line if it already held a copy:
    ```bash
    docker compose -f docker/compose.scale.yml logs server-a server-b | grep "session $SID"
    ```
    Start the stopped instance again, and wait 5 seconds before stopping anything else, because the proxy skips a server for 5 seconds after a failed attempt:
    ```bash
    docker compose -f docker/compose.scale.yml start server-a
    ```
12. Look at the stored session in Redis. Expect one `mcp:session:<id>` key per session you opened:
    ```bash
    docker compose -f docker/compose.scale.yml exec redis redis-cli keys 'mcp:session:*'
    ```
13. Stop and remove everything. The issuer's signing key stays in the `issuer-keys` volume, so old tokens still verify after the next `up`:
    ```bash
    docker compose -f docker/compose.scale.yml down
    ```
    To delete the key as well, add `-v`. And stop the test Redis from step 3 if you started it:
    ```bash
    docker compose -f docker/compose.scale.yml down -v
    ```
    ```bash
    docker stop mcp-test-redis
    ```

## New packages

| Package | Version | What it is | Why this one | Where it is used |
|---|---|---|---|---|
| `ioredis` | 6.0.0 | A Redis client for Node: it opens a connection to a Redis server and sends commands such as `GET`, `SET` and `DEL`. | Redis is a separate server, and Node has no built-in way to talk to it. We chose `ioredis` for its TypeScript types and built-in reconnect. The other common choice is the official `redis` package. | [`src/session-store-redis.ts`](../../packages/server/src/session-store-redis.ts) (`RedisSessionStore`) and the startup check in `http.ts`. Only loaded when `SESSION_STORE=redis`. |

**Docker images used by 11.4** (not packages, but each is something new this stage runs):

| Image | What it is | Why this one | Where it is used |
|---|---|---|---|
| `node:24.22.2-alpine` | Node.js on Alpine Linux, a small base image. | The exact patch version CI pins (24.22.2), so the containers and CI run the same Node, and much smaller than the full `node` image. | `server-a`, `server-b` and `issuer` in [`docker/compose.scale.yml`](../../docker/compose.scale.yml). |
| `nginx:alpine` | The nginx web server, small build. | A reverse proxy that does SSE well once buffering is off. The other common choice is Caddy. | `proxy`, configured by [`docker/proxy.conf`](../../docker/proxy.conf). |
| `redis:7` | The Redis server. | The same image used by hand in 11.2. | `redis` in the compose file. |

Notes:
- **Run against a real server:** `ioredis` was exercised against Redis 7 in Docker in 11.2 (see its Proof section), and again in the 11.3 and 11.4 runs.
- **Earlier packages without an explanation** (`jose` in Stage 9, `zod` in Stage 10) are not covered here. Say if you want me to add them to their stage docs.

## Try it end to end

Run the stage in order. The commands are in each step's "Test it yourself" section:

1. 11.1, steps 1 to 4: the suite, the store and spike tests, and behaviour unchanged.
2. 11.2, steps 1 to 7: start Redis, run the real-Redis tests, then two instances by hand.
3. 11.3, steps 1 to 7: the event store tests, the full suite, replay with `Last-Event-ID`, off by default, and a late replay being refused.
4. 11.4, steps 1 to 13: build, the two-instance tests, start the Docker stack, get a token, run the kill test, do the same by hand, then stop everything.
