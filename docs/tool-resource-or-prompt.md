# Tool, resource or prompt?

An MCP server can offer three kinds of things. The difference is **who decides to use it**, not what it contains. Pick by asking that question first.

| | Tool | Resource | Prompt |
|---|---|---|---|
| **Chosen by** | the model | the app or user | the user |
| **What it is** | an action or live lookup | read-only data at a URI | a request template |
| **Side effects** | allowed | never | none (it only builds text) |
| **Client calls** | `tools/list`, `tools/call` | `resources/list`, `resources/read` | `prompts/list`, `prompts/get` |
| **Shows up as** | something the model can call | something you attach as context | a menu item or slash command |
| **Here** | `get_weather` | `weather://city/dubai` | `compare_weather` |

## How to choose

1. **Does it do something, or fetch live data that changes?** Use a **tool**. `get_weather` calls an outside API, so the model has to trigger it when it needs a fresh answer.
2. **Is it stable data that should simply be available as context?** Use a **resource**. The city table never changes during a session, and reading it twice gives the same result. An app can list resources, cache them and let the user attach one.
3. **Is it a request a person would otherwise retype?** Use a **prompt**. `compare_weather` packages "call `get_weather_batch` with these coordinates, then compare" so the user only picks two cities.

If two apply, the safer one is usually the one with fewer powers: a resource cannot change anything, a tool can.

## The same city table, three ways

| Need | Primitive | Why |
|---|---|---|
| Current temperature in Dubai | tool (`get_weather`) | live data, needs a network call |
| The coordinates of Dubai | resource (`weather://city/dubai`) | fixed reference data, no action |
| "Compare Dubai and Delhi" | prompt (`compare_weather`) | a ready-made request that tells the model which tool to call |

## Completions

Completion is not a fourth kind of thing. It is autocomplete for the arguments of prompts and the variables in resource URIs. A client sends what the user has typed (`d`) and gets matches back (`dubai`, `delhi`).

## Common mistakes

- **Making everything a tool.** The model then sees a long list of tools for data that never needed a call, and each one costs it attention.
- **Expecting the model to pick a prompt or resource on its own.** The model is handed tools. Prompts and resources reach the user through the client's UI, so asking a model "do you have a `weather_report` prompt?" gets the wrong answer.
- **Treating a prompt as an answer.** A prompt returns message text. A model has to read it before anything happens. This repo's scripted clients only print it.

## Client support varies

How each app shows resources and prompts differs, and some show only one. In Cursor the prompts appeared under `/` as `/user-mcp-demo-http/weather_report`. See [connecting-clients.md](connecting-clients.md) for setup, and [branch #13](branches/13-stage-5-resources-prompts.md) for what Stage 5 added.
