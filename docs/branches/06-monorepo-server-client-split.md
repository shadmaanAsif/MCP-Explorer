# #6 — Side exploration: monorepo split (`06-monorepo-server-client-split`)

**Status:** merged into `main`.

## What it did

Originally the repo was one flat package: one `package.json` and one `src/`, shared by the server and the custom client. This branch split them into **fully separate packages** in a workspaces monorepo (npm workspaces at the time; the repo moved to pnpm in [#9](09-switch-to-pnpm.md)).

## What changed

```
MCP-Explorer/
├── package.json          # workspace root: no code, just wiring
├── tsconfig.base.json    # compiler options shared by every package
└── packages/
    ├── server/           # @mcp-explorer/server: its own deps, build, start
    └── client/           # @mcp-explorer/client: its own deps, build, start
```

- **Workspace root `package.json`**: lists `packages/*`, so one install at the root links the packages. Its scripts forward to the right package (`build` builds both; `start` and `client` each target one workspace), so the top-level commands did not change.
- **`tsconfig.base.json`**: the compiler options (`target`, `module`, `strict`) are identical for both packages, so they live once here. Each package's own `tsconfig.json` extends it and only adds `rootDir` and `outDir`.
- **Separate `package.json` per package**: each declares only what it uses. The client never needed `zod`, for example. The two halves of the protocol stay genuinely decoupled, not just in different folders.
- **`.gitignore`**: keeps every `node_modules/` and `build/` out of git. The pattern matches at any depth.
- Nothing else was added: no shared internal package and no test framework. Those would answer problems the project did not have yet.

## Side effects

- The client could no longer assume the server's compiled file sat next to it, so it resolved the server path relative to its own file location. That whole mechanism disappeared in [#8](08-server-http-transport.md).
- The web dashboard started here as a plain Express server with one static HTML file. It was rebuilt in [#7](07-web-nextjs-react.md).

## How to try it

```bash
pnpm install
pnpm build
```

`pnpm build` compiles both packages, each into its own `build/` folder. Client connection steps: [connecting-clients.md](../connecting-clients.md).
