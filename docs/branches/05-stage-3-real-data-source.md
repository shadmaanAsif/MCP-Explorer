# #5 — Stage 3: a real data source (`05-stage-3-real-data-source`)

**Status:** merged into `main`.

## What it did

Added `get_weather(latitude, longitude)`, which calls [Open-Meteo](https://open-meteo.com/) (free, no API key) for the current temperature and wind speed. It is the first tool that does real I/O instead of pure math.

## What changed

```ts
const response = await fetch(url);
if (!response.ok) {
  return { isError: true, content: [{ type: 'text', text: `Open-Meteo returned ${response.status} ${response.statusText}` }] };
}
```

A `try`/`catch` around the `fetch` catches network failure (DNS, unreachable host) the same way `divide`'s `.refine()` catches bad input: as a normal `isError: true` result, not a crash.

## Verified

- A real call against Open-Meteo.
- A call against a deliberately unreachable host, which returned `Failed to reach Open-Meteo: fetch failed` instead of an unhandled rejection.

## What it deliberately left out

No retries, no timeout and no partial-data handling. The only goal was that the process does not die when the network does not cooperate. [#10](10-stage-4-error-handling-realtime.md) adds the rest.

## How to try it

Connect any client (see [connecting-clients.md](../connecting-clients.md)) and run `get_weather` with a latitude and longitude, for example `25.2048` and `55.2708` (Dubai). With the scripted client: `pnpm start:http`, then `pnpm client`.
