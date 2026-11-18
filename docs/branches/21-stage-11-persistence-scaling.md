# #21 — Stage 11: persistence and scaling (`21-stage-11-persistence-scaling`)

**Status:** in progress. Step 11.1 is built; 11.2 to 11.4 are not started. Plan: [docs/plans/stage-11-persistence-scaling.md](../plans/stage-11-persistence-scaling.md).

Stage 11 lets an HTTP session survive a restart and work across several server instances. Today a session lives in one process's memory.

## Steps at a glance

| Step | What it builds | Status |
|---|---|---|
| 11.1 | A session store interface and a spike that proves another instance can take over a session | Built |
| 11.2 | Redis store, and rebuilding a session on a store hit | Not started |
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
