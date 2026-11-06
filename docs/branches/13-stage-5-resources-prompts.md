# #13 — Stage 5: resources, prompts and completions (`13-stage-5-resources-prompts`)

**Status:** in progress. The server side is built and tested. The CLI client demo and the docs index are still to do.

## What it does

Until now the server offered only **tools**. MCP servers can offer three kinds of things, and this stage adds the other two, plus argument completion.

| Kind | Who triggers it | Used for | In this project |
|---|---|---|---|
| **Tool** | the model decides | doing something, or fetching live data | `get_weather` |
| **Resource** | the app or user attaches it | read-only data as context, addressed by a URI | `weather://city/dubai` |
| **Prompt** | the user picks it | a ready-made request | `compare_weather` |
| **Completion** | the client asks while typing | autocomplete for prompt and resource arguments | `du` → `dubai` |

A resource only reads, with no side effects. A prompt only builds message text. It does not produce an AI answer: a model has to read that text, and this project's scripted clients only print it.

## What changed

New file [`catalog.ts`](../../packages/server/src/catalog.ts), registered from `createServer()` with one line, `registerCatalog(server, session)`. Everything reads from a fixed five-city table (Dubai, Delhi, London, Tokyo, New York), so there is no new upstream API.

**Resources**
- `weather://cities`: every known city with its coordinates.
- `weather://city/{name}`: one city. This is a URI template; each city also shows up in `resources/list`.
- `session://home`: the location saved by `set_home_location`. It reads `null` in stateless mode, because each request gets a fresh session.

**Prompts**
- `compare_weather(cityA, cityB)`: asks the model to call `get_weather_batch` for both cities and say which is warmer and windier.
- `weather_report(city, style)`: asks for a `brief` or `detailed` report, naming the `get_weather` call to make.

**Completions**: prefix matching on the city and style arguments, and on `{name}` in the city URI. Built with the SDK's `completable()` helper and `ResourceTemplate`'s `complete` option.

**Errors**: an unknown city returns `-32602 Unknown city "atlantis". Known: dubai, delhi, london, tokyo, new-york`. A missing prompt argument returns `-32602 Invalid arguments for prompt compare_weather: … at cityB`.

## Verified

A script ran 17 calls over stateful HTTP, and the key ones over stateless HTTP and stdio:
- the server declares `completions`, `prompts`, `resources` and `tools` in all three modes
- `weather://city/dubai` returns its coordinates, and `resources/list` returns seven entries
- completions: `d` gives `dubai` and `delhi`, `de` on style gives `detailed`, and `n` on the city URI gives `new-york`
- `session://home` is `null`, then the saved value after `set_home_location` in stateful HTTP and stdio, and stays `null` in stateless HTTP

## How to connect and try it

Build, start the HTTP server, and reconnect your client (see [connecting-clients.md](../connecting-clients.md) §7):
```bash
pnpm build
pnpm start:http
```

**Cursor** (verified): after reloading the MCP server, type `/` in the chat. The prompts appear as `/user-mcp-demo-http/weather_report` and `/user-mcp-demo-http/compare_weather`. Picking one asks for its arguments, with completion, and sends the generated text to the model, which then calls the tools. The name prefix comes from your `mcp.json` entry. Asking the model in words whether a prompt exists does not work, because the model is given tools.

**MCP Inspector** (not run against this server): the **Resources** and **Prompts** tabs should list the new items, and the Prompts tab can fetch a prompt with arguments.

**Any client**, from code:
```ts
await client.listResources();
await client.readResource({ uri: 'weather://city/dubai' });
await client.getPrompt({ name: 'compare_weather', arguments: { cityA: 'dubai', cityB: 'delhi' } });
await client.complete({ ref: { type: 'ref/prompt', name: 'compare_weather' }, argument: { name: 'cityA', value: 'd' } });
```

## Still to do

- A section in [`client.ts`](../../packages/client/src/client.ts) that lists and reads resources, gets a prompt and requests a completion.
- A "tool, resource or prompt?" guide in the README.
- The web dashboard has no screen for resources or prompts.
