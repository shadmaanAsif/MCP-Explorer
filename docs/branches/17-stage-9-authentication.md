# #17 — Stage 9: authentication (`17-stage-9-authentication`)

**Status:** planning done; 9.1 to 9.4 built; 9.5 (final tests and docs) to do. This file is updated as the steps land.

## Contents

- [Phase planning](#phase-planning-commit-1)
- [Steps at a glance](#steps-at-a-glance)
- [Config: one `.env` per package](#config-one-env-per-package)
- [9.1 Token issuer](#91-token-issuer)
- [9.2 Protected-resource metadata](#92-protected-resource-metadata)
- [9.3 Bearer middleware](#93-bearer-middleware)
- [9.4 Clients send the token](#94-clients-send-the-token)

## Phase planning (commit 1)

The roadmap was one flat list of Stages 1–13. It is now grouped into three **phases**, each written the same way: goal, what you can do when it's done, stages with numbered steps, done when, out of scope.

1. **Build the server** (Stages 1–8): done.
2. **Make it production-ready** (Stages 9–13): next.
3. **Build the client** (Stages 14–18): planned.

- **Changed:** `README.md` (roadmap, phase diagram, Phase 2 steps table), `constitution/planning.md` (new: format and rules), `CLAUDE.md` (points to it), `docs/plans/stage-9-authentication.md` (new: the Stage 9 plan).
- **One PR:** planning and the stage it plans share this branch.

## Steps at a glance

Steps come from [the plan](../plans/stage-9-authentication.md).

| Step | What it builds | Where | Status |
|---|---|---|---|
| 9.1 | Token issuer: signs tokens, publishes the public key | `src/auth/issuer.ts`, `issuer-cli.ts` | Done |
| 9.2 | Public notice of where tokens come from | `src/auth/resource-metadata.ts` | Done |
| 9.3 | The guard on `/mcp` | `src/auth/middleware.ts` | Done |
| 9.4 | CLI client and dashboard send the token | `packages/client/src/connection.ts` | Done |
| 9.5 | Final tests, token guide, README and roadmap | docs | To do |

## Config: one `.env` per package

- **Files:** `packages/server`, `packages/client` and `packages/web` each have a committed `.env.example` and a git-ignored `.env`. Copy each template with `cp`.
- **Loading:** the server, issuer and client scripts run `node --env-file-if-exists=.env`, because Node never reads `.env` itself. Missing file: the code defaults apply.
- **Dashboard:** Next.js reads its own `.env`, and `packages/web/scripts/next.mjs` takes `WEB_PORT` from it.
- **Precedence:** shell variable, then flag, then file, then built-in default. No `.env` still works.
- **Cost:** `MCP_SERVER_URL` is in all three files, so change it in each if the server's port changes.
- **Checked:** server, issuer, client and dashboard all ran on ports 5767 to 5769 from changed per-package files.

## 9.1 Token issuer

**What it is:** a stand-in identity provider. It makes a key pair, signs tokens with the private key, and publishes only the public key.

**Files:** `src/auth/issuer.ts` (keys, signing, routes) and `issuer-cli.ts` (the `pnpm issuer` command). The current MCP spec (2026-07-28) was read first; three errors in the plan's spec list were fixed.

**Two commands, one key file.** Both share `.auth/issuer-key.json` (git-ignored, mode 0600, created on first run).

| | `pnpm issuer token` | `pnpm issuer serve` |
|---|---|---|
| Job | Make a token | Publish the public key |
| Key used | Private (signs) | Public only |
| Lifetime | Prints and exits | Runs until Ctrl+C |
| Needs the other running | No | No |

`serve` must be up only while the MCP server verifies tokens (`AUTH_REQUIRED=1`); if it is down the server answers `503`.

### Try it

Run from the repo root. Run `pnpm build` first if `src/` changed.

1. **Start the issuer** in its own tab:
   ```bash
   pnpm issuer serve
   ```
2. **Check the public key** (needs `serve`). It must have `kty`, `n`, `e`, `kid` and no `d`, which would be the private part:
   ```bash
   curl localhost:4769/jwks.json
   ```
3. **Check the metadata** (needs `serve`). It returns `{"issuer":"http://localhost:4769","jwks_uri":"http://localhost:4769/jwks.json"}`:
   ```bash
   curl localhost:4769/.well-known/oauth-authorization-server
   ```
4. **Make a token** (works with `serve` stopped):
   ```bash
   pnpm issuer token --sub alice --scope "mcp:tools"
   ```
5. **Keep it in a variable** (`--silent` prints only the token):
   ```bash
   export MCP_TOKEN=$(pnpm --silent issuer token --sub alice --scope "mcp:tools")
   ```

Token flags: `--sub` who it is for, `--scope` what it may do, `--aud` which server (default `TOKEN_AUDIENCE`), `--ttl` seconds until it expires.

### How the CLI reads its arguments

`pnpm issuer …` appends your words to the script `node --env-file-if-exists=.env build/auth/issuer-cli.js`. The CLI's first line is `const [command, ...rest] = process.argv.slice(2);`

1. **`process.argv`:** a built-in Node array of the words on the command line: the node program, the script path, then your arguments (the shell removes quotes).
2. **`.slice(2)`:** drops the first two, leaving `['token', '--sub', 'alice', '--scope', 'mcp:tools']`.
3. **Destructuring:** `command` is `'token'` and `rest` is `['--sub', 'alice', '--scope', 'mcp:tools']`.
4. **Then:** `rest` goes to Node's `parseArgs`, giving `{ sub: 'alice', scope: 'mcp:tools' }`. `command` picks the branch: `token` prints a token, `serve` starts the issuer, anything else prints usage.

Check it: `node -e "console.log(process.argv.slice(2))" token --sub alice` prints `[ 'token', '--sub', 'alice' ]`.

**Tests (7):** a good token verifies; a wrong key, audience, issuer or expired time is refused; the JWKS has no private part; the key file is 0600 and reused between runs.

## 9.2 Protected-resource metadata

- **What:** `src/auth/resource-metadata.ts` serves `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`.
- **Returns:** the resource URL (`MCP_SERVER_URL`) and `authorization_servers` (`ISSUER_URL`).
- **Public:** no token needed, since a client reads it before it has one.
- **Tests (3):** removing the route fails all three.

## 9.3 Bearer middleware

**What:** `src/auth/middleware.ts`, a Hono middleware in front of `/mcp`. Switched on with `AUTH_REQUIRED=1`; off by default so the existing clients keep working.

**Checks:** signature (keys fetched from the issuer's `/jwks.json` and cached), issuer, expiry, and that `aud` is this server (`MCP_SERVER_URL`).

| Request | Answer |
|---|---|
| No header | `401` with `resource_metadata` and `scope` |
| Malformed header | `400 invalid_request` |
| Bad, expired or wrong-audience token | `401 invalid_token` |
| Issuer unreachable | `503` |
| Valid token | passes; `sub` and `scope` go on the request context for Stage 10 |

- **D4 decided:** our own middleware, not the SDK's Express one.
- **Tests:** 12 unit and 4 end-to-end against the real server and a real issuer. Removing the audience check fails 2.

## 9.4 Clients send the token

- **Sending:** `connectToServer` (`packages/client/src/connection.ts`) reads `MCP_TOKEN` and sends `Authorization: Bearer …` on every request. The CLI client and the dashboard both use it.
- **On a `401`:** it throws an `AuthRequiredError` saying whether the token was missing or refused, how to make one (`pnpm issuer token …`, with the scope from `WWW-Authenticate`) and the metadata URL.
- **CLI:** prints just that message.
- **Dashboard:** shows it on the page instead of an error page. A failed connection is no longer cached, so fixing the token and restarting is enough.
- **Config:** set `MCP_TOKEN` in `packages/client/.env` or `packages/web/.env` (both `.env.example` files list it).
- **Tests (3):** `test/client-auth.test.ts` runs the client against the real server and issuer. Removing the header fails the valid-token test.
