# Plan: Stage 11, persistence and scaling

**Phase 2, stage 3 of 5.** Branch: `21-stage-11-persistence-scaling` (cut from `main` after PR 20 merges). Status: planned.

## Goal

Today a stateful session lives only in one process's memory. Restart the server and every session is gone; start a second instance and a client's session id works on only one of them. Stage 11 moves the part of a session that can move into a shared store (Redis), so a restart or a second instance does not lose it, and lets a dropped stream resume with `Last-Event-ID`.

## You can do this when it's done

Start two server instances and a proxy in front, connect a client, and call a tool. Kill the instance that answered. The client's next call, with the same `Mcp-Session-Id`, is answered by the other instance and still sees the session's state (for example the home location set by `set_home_location`). Cut a streaming call's connection and reconnect with `Last-Event-ID`: the events after that id arrive again.

## Starting point (already built)

- `http.ts` keeps `sessions: Map<id, Session>`. A `Session` holds a live `McpServer`, a live transport, a `SessionState` (`{ home? }`), `lastSeen` and `owner` (the `sub`).
- `sweepIdleSessions` closes sessions idle past `MCP_SESSION_TTL_MS`.
- Stateless mode already scales horizontally but has no sessions, no `GET` stream and no per-session state.
- The SDK transport has an `eventStore` option and an `EventStore` interface (`storeEvent`, `replayEventsAfter`) for resumability. I read this in `webStandardStreamableHttp.d.ts` (SDK 1.32.2). I have **not** run it.
- `config.ts` validates every HTTP setting at startup (10.5), so new settings go there.

## The hard part (read this first)

A session is two things:

| Part | Can it move to a store? |
|---|---|
| **Data**: owner, `home`, created and last-seen times, the client's `initialize` parameters | Yes, it is plain JSON |
| **Live objects**: the `McpServer`, the transport, open SSE streams, a tool call that is running | No. They are in-process and cannot be serialised |

So "persistence" means: store the data, and **rebuild** the live objects on whichever instance receives the request. Whether a rebuilt transport accepts a session id it never issued is **unverified**. In the SDK source the transport sets `_initialized` and `sessionId` itself when it handles `initialize`, and `_initialized` is private. Step 11.1 starts by proving or disproving this.

## Decisions

| # | Decision | Proposal | Status |
|---|---|---|---|
| D1 | How another instance takes over a session | **A**: on a store hit with no local session, build a new `McpServer` and transport, restore the data, and replay the stored `initialize` so the SDK treats it as initialised. **B** (fallback if A fails the 11.1 spike): the proxy sticks a session to one instance by `Mcp-Session-Id`, and a dead instance's sessions answer `404` so the client re-initialises (our clients already do). B loses the live session, but not the data a new session would not need | open, decided by the 11.1 spike |
| D2 | Which store | Redis, behind a `SessionStore` interface with an in-memory implementation (the default, today's behaviour) and a Redis one. `SESSION_STORE=memory\|redis`, `REDIS_URL` | proposed |
| D3 | Redis client | `ioredis` | proposed, unchecked against current docs |
| D4 | Idle timeout with Redis | The Redis key expires after `MCP_SESSION_TTL_MS` and each request refreshes it, so the sweeper is only needed for the memory store | proposed |
| D5 | Rate limit buckets (10.3) | Stay per instance, and the doc says so. Moving them to Redis is optional and only if time allows | proposed |
| D6 | Redis in tests and CI | The store contract tests run against memory always, and against Redis when `REDIS_URL` is set. CI gets a Redis service container. Local runs without Redis skip those tests, loudly | proposed |
| D7 | Stateless mode | Unchanged | decided |

## Steps

**11.1 Session store interface (and the spike).**
First, a throwaway test that builds a second transport, sets the session id, replays `initialize` and answers a `tools/call`. The result picks D1 A or B and is recorded here. Then `SessionStore` (`get`, `set`, `touch`, `delete`) over a plain `SessionRecord` (`id`, `owner`, `state`, `initializeParams`, `createdAt`, `lastSeen`), an in-memory implementation, and `http.ts` using it for the data while the live objects stay in the local map.
*Files:* `src/session-store.ts` (new), `src/http.ts`, `test/session-store.test.ts` (new).
*Done when:* behaviour is unchanged (all 233 tests pass), the store has contract tests, and the D1 result is written in this plan.

**11.2 Redis store.**
A Redis implementation of the same interface, with key expiry (D4). New settings `SESSION_STORE`, `REDIS_URL` in `config.ts`, with the usual startup validation (`redis` needs `REDIS_URL`; the message never prints the URL, which can hold a password). On a miss in the local map, `handleStateful` asks the store and, per D1, rebuilds.
*Files:* `src/session-store-redis.ts` (new), `src/config.ts`, `src/http.ts`, `package.json` (`ioredis`), tests, `.env.example`.
*Done when:* the same contract tests pass against Redis, and a test restarts the server process and the session id still works with its `home` intact.

**11.3 Resumable streams.**
An `EventStore` (memory and Redis) passed to the transport, so events are stored per stream and replayed after `Last-Event-ID`. Bounded: a maximum number of events per stream and an expiry, set in config.
*Files:* `src/event-store.ts` (new), `src/http.ts`, `src/config.ts`, tests.
*Done when:* a test opens a stream, drops it, reconnects with `Last-Event-ID` and receives exactly the later events, with the store capped as configured.

**11.4 Two instances behind a proxy.**
A `docker-compose` file with Redis, two server instances and a small proxy (nginx or Caddy), with no SSE buffering. A script (or test) kills one instance mid-session. The proxy config is the start of Stage 13's gateway work, so keep it minimal.
*Files:* `docker/compose.scale.yml`, `docker/proxy.conf`, an end-to-end script, docs.
*Done when:* the kill test passes: the session id keeps working and its state is intact.

Then the branch doc (ending with **Try it end to end**, per `constitution/planning.md`), the README row and the roadmap page.

## Behaviour table (the proof)

| Situation | Answer |
|---|---|
| Restart the only instance, then call with the old session id | works, state intact (store hit, objects rebuilt) |
| Second instance gets a session id it never saw | works (store hit) |
| Session id not in the store (expired or never existed) | `404`, the client re-initialises |
| Another caller's token with a stored session id | `403` (the owner comes from the store) |
| Redis down at startup with `SESSION_STORE=redis` | the server does not start, the message says why |
| Redis goes down while running | requests that need the store get `503` with `Retry-After`, nothing else breaks |
| Stream dropped, reconnect with `Last-Event-ID` | later events replayed |
| `Last-Event-ID` older than the retained events | replay from the oldest retained, and the doc says events may be missing |

## Risks

- **D1 may fail.** The SDK may not let a rebuilt transport adopt a session id. That is why 11.1 starts with a spike and has fallback B.
- **A running tool call dies with its instance.** Resumability only replays events that were stored. The result of a call that was mid-run when the instance died is lost, and the client has to call again.
- **Cancel across instances.** `notifications/cancelled` for a call running on instance A, sent to instance B, does not reach it. Same family as the cancel limit already noted for stateless mode.
- **Per-session state is tiny today** (`home` only). A rebuilt session is only as faithful as what the record stores, so anything new added to `SessionState` must be added to the record.
- **Redis is now a dependency.** A new thing that can be down, and one more secret (`REDIS_URL`).
- **Rate limits per instance (D5).** Two instances each allow the full rate.
- **Not run yet:** nothing in this plan has been tried, including Redis commands and `ioredis` usage. Treat library details as unverified until 11.2.

## Out of scope

Redis clustering and high availability, running Redis for production (Stage 13), distributed locking, migrating sessions between store types, metrics on the store (Stage 12), and the gateway's TLS and routing rules beyond the minimal proxy in 11.4.
