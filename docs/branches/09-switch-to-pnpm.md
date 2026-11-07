# #9 — Side exploration: switch to pnpm (`09-switch-to-pnpm`)

**Status:** merged into `main` (PR [#9](https://github.com/shadmaanAsif/MCP-Explorer/pull/9)).

## What it did

Moved the repo from npm to pnpm. From here on every command in the docs is a `pnpm` command.

## What changed

- **`pnpm-workspace.yaml`** lists `packages/*`, and `pnpm-lock.yaml` replaced `package-lock.json`.
- **`workspace:*`**: `web` depends on the client package this way.
- **`packageManager`** in the root `package.json` pins the pnpm version (`pnpm@12.8.1`), so everyone resolves the same one.
- **Strict dependencies.** A package can import only what its own `package.json` declares, so nothing leaks in through hoisting. `web` imported the MCP SDK without declaring it, and `next build` failed with `Cannot find module '@modelcontextprotocol/sdk/...'` until `@modelcontextprotocol/sdk` was added to `packages/web/package.json`.
- **`pnpm dlx`** replaces `npx` for one-off tools such as the Inspector.

## How to try it

```bash
pnpm install
pnpm build
```

## Notes

- **`pnpm: command not found`:** nvm keeps global tools per Node version, so pnpm exists only under the Node versions where it was installed. Use one that has it, or run `npm install -g pnpm` under the version you are on. See [connecting-clients.md](../connecting-clients.md) §8.
- Stale `.next` and `*.tsbuildinfo` caches can produce false type errors after the switch. Delete them if you see `implicitly any` errors that do not match the code.
