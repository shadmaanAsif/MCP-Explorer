# #7 — Side exploration: Next.js web dashboard (`07-web-nextjs-react`)

**Status:** merged into `main`.

## What it did

Rebuilt the web dashboard as a real Next.js + React app. The dashboard is a browser GUI that discovers the server's tools live and lets you run them by filling in a form, with no code editing to try different input. It is a third client, alongside the Inspector and the scripted `client.ts`.

Before this it was a plain Express server serving one static HTML file, talking to `@mcp-explorer/client` through two hand-rolled endpoints (`GET /api/tools`, `POST /api/call`).

## What it does

- [`page.tsx`](../../packages/web/src/app/page.tsx) is an async **Server Component**. It calls `getClient()` and `listTools()` directly on the server, with no REST hop.
- Each tool renders as a [`ToolCard`](../../packages/web/src/components/ToolCard.tsx), a Client Component that builds its input fields from the tool's live `inputSchema`.
- "Run" calls a **Server Action**, [`runTool()`](../../packages/web/src/app/actions.ts), like any other async function, with no `fetch` or `JSON.stringify`.

## Why Server Components and Server Actions

The old endpoints could have been ported to Route Handlers unchanged: a smaller diff with the same mental model. Building it the other way is the point, because Server Components and Server Actions are what is actually different about Next.js.

## The connection is a singleton

[`mcp-client.ts`](../../packages/web/src/lib/mcp-client.ts) caches the **in-flight promise** from `connectToServer()` on `globalThis`:
- **`globalThis`, not a module variable:** dev-mode Fast Refresh re-evaluates a module's scope on every edit. A module variable would reset and open a new connection on each reload. `globalThis` survives it.
- **The promise, not the resolved client:** two requests that arrive before the first connection resolves do not each open their own.

## `page.tsx` is forced dynamic

`export const dynamic = 'force-dynamic'`. Without it, `next build` would statically prerender the route, which runs the Server Component, so it would connect to the MCP server at build time and bake that one tool list into static HTML.

## How to try it

```bash
pnpm start:http     # terminal 1
pnpm web            # terminal 2: production build, http://localhost:4767
```

`pnpm web:dev` runs it with hot reload. The server must be running first. Later additions: a JSON textarea for array arguments, reconnect after a server restart ([#11](11-stage-4-wrapup.md)) and a Cancel button ([#12](12-stage-4-verify-docs.md)). More in [connecting-clients.md](../connecting-clients.md).
