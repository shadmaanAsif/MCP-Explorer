# #18 — `run_checks` uses the project's own package manager (`18-run-checks-package-manager`)

**Status:** built, not yet merged. A fix to the Stage 8 code review server, not a new stage.

## Why

`run_checks` always ran `pnpm run <script>`. Pointed at an npm project (`ct-web-hotels`, which has a `package-lock.json`), pnpm 12 **installed the dependencies and wrote a `pnpm-lock.yaml` into the reviewed repo** before it ran the script. That replaced the project's `node_modules` and broke its dev server. A review tool must not change the project it reads. This was found when Cursor's agent traced the changes back to the MCP server.

## What changed

All in `review.ts` (since branch 19 [`review/helpers/checks.ts`](../../packages/server/src/review/helpers/checks.ts)), `run_checks` only:

| Before | Now |
|---|---|
| Always `pnpm run <name>` | The project's own manager: `packageManager` in `package.json`, then the lockfile (`package-lock.json` → npm, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`/`bun.lockb`). If a `package-lock.json` exists, npm wins, because a stray second lockfile is the usual cause. No lockfile means npm. |
| A script the project lacks gave a failing check | It is `skipped`, with "package.json has no "<name>" script." The other checks still run. |
| No sign of what ran | Each result shows the command, for example `$ npm run build`. |
| pnpm could install and write a lockfile | pnpm runs with `pnpm_config_verify_deps_before_run=false` and `pnpm_config_lockfile=false`. Checked on pnpm 12.8.1: **neither setting is enough alone**. |
| A project with no `package.json` | A clear tool error instead of failing checks. |

The caller still never supplies a command: the script name comes from the fixed list (`build`, `test`, `typecheck`) and the manager from a fixed list of four.

## Tests

4 new tests in [`review.test.ts`](../../packages/server/test/review.test.ts) (151 in total): an npm project is run with npm and left untouched; pnpm does not install or write a lockfile; a missing script is skipped while the others run; no `package.json` is an error. Removing the two pnpm settings makes the pnpm test fail. The contract snapshot changed only in the `run_checks` description.

## Still true

- `run_checks` runs the project's own scripts as you. Build output and test side effects are the project's own.
- A slow check can still hit the client's request timeout (`-32001` in Cursor). Background checks are not built.
- If a project was already damaged by the old behaviour: delete the stray `pnpm-lock.yaml` and reinstall with the project's own manager.

How to connect and try it: [docs/connecting-clients.md](../connecting-clients.md), section 9.
