# #14 — Stage 6: testing and CI (`14-stage-6-testing-ci`)

**Status:** built, not yet merged. The GitHub Actions workflow has never run on GitHub, so it may need a fix after the first PR.

## What it does

Every check in Stages 1-5 was done by hand. This stage turns them into automated tests that run on every PR, so the server can change without breaking what clients rely on.

## What changed

- **Runner:** Vitest. `pnpm test` runs once, `pnpm test:watch` watches. Config in [`vitest.config.mts`](../../vitest.config.mts).
- **Build first:** [`vitest.global-setup.mts`](../../vitest.global-setup.mts) compiles the server before any test, so the HTTP tests never run against an old build.
- **Test settings in the server:** `fetchWeather` is exported, and `WEATHER_FETCH_TIMEOUT_MS` and `WEATHER_RETRY_BASE_DELAY_MS` can shorten the timeout and backoff. Defaults are unchanged (8s, 300ms).

56 tests, about 6s:

| File | Tests | What it covers |
|---|---|---|
| [`fetch-weather.test.ts`](../../packages/server/test/fetch-weather.test.ts) | 10 | Success, 404 / bad JSON / wrong shape (1 call each), 5xx and hang (3 calls), recovery, unreachable upstream, cancel mid-request. Uses a local stub, so no internet. |
| [`in-memory.test.ts`](../../packages/server/test/in-memory.test.ts) | 28 | A real client and server joined in one process, no port. Tools, batch progress and partial failure, session state, resources, prompts, completions, `-32602` errors. |
| [`http.test.ts`](../../packages/server/test/http.test.ts) | 15 | The real `build/http.js` on a free port. Stateful: 400/404 session rules, per-session state, terminate, cancel reaching the running call, idle sweep. Stateless: 405, no session id, cancel does **not** stop the upstream call. |
| [`contract.test.ts`](../../packages/server/test/contract.test.ts) | 3 | A **snapshot** of every tool, resource, template and prompt (names, descriptions, input schemas). |

**Snapshot test:** the first run saves the output to [`__snapshots__/`](../../packages/server/test/__snapshots__/contract.test.ts.snap). Later runs fail if it changes, so a renamed tool or changed input field shows up in the PR. If the change is intended, update it with `pnpm exec vitest run -u` and commit the new snapshot.

**CI:** [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on every PR and on pushes to `main`: `pnpm install --frozen-lockfile`, `pnpm build` (server, client and the web app), `pnpm test`, on Node 24.

## How to run

```bash
pnpm test
```

No server needs to be running. The HTTP tests start their own on free ports.

## Verified

- All 56 tests pass, and the suite passed 4 times in a row on the HTTP tests.
- Each test group was checked by breaking the code on purpose (wrong status code, disabled sweep, removed `lastSeen` refresh, forced stateless mode, broken batch error rule, a changed tool description) and confirming a test failed.
- The CI commands pass locally.

## Not covered

- The dashboard UI has no tests.
- No test has a model read a prompt.
- Nothing runs against the real Open-Meteo API.
- The cancel and idle-sweep tests use short real timers (600ms), so a slow CI runner could make them flaky.
- The workflow YAML and `pnpm/action-setup` with pnpm 12 are unproven until the first run on GitHub.

Connecting clients: [docs/connecting-clients.md](../connecting-clients.md).
