# #17 — Stage 9: authentication (`17-stage-9-authentication`)

**Status:** planning done; the build is in progress. This file is updated as the steps land.

## Commit 1: phase planning (docs only)

The roadmap was one flat list of Stages 1–13. It is now grouped into three **phases**, each written the same way (goal, what you can do when it's done, stages with numbered steps, done when, out of scope):

1. **Build the server** (Stages 1–8), done.
2. **Make it production-ready** (Stages 9–13), next.
3. **Build the client** (Stages 14–18), planned.

What changed: `README.md` (roadmap section, phase diagram, Phase 2 steps table), `constitution/planning.md` (new: the format and rules), `CLAUDE.md` (points to it), `docs/plans/stage-9-authentication.md` (new: the Stage 9 plan). Planning and the stage it plans share this branch, so the plan and the build land in one PR.

## Commits 2 onward: the build

Steps 9.1 to 9.5 from [the plan](../plans/stage-9-authentication.md).

**9.1, done: the token issuer.** The current MCP spec (2026-07-28) was read first; the plan's spec list had three errors, now fixed in the plan. `packages/server/src/auth/issuer.ts` signs RS256 tokens and publishes the public key; `issuer-cli.ts` runs it.

**9.2, done: protected-resource metadata.** `src/auth/resource-metadata.ts` serves `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` with the resource URL (`MCP_SERVER_URL`) and `authorization_servers` (`ISSUER_URL`). Both routes are public. Three tests; removing the route fails all three.

**9.3, done: the bearer middleware.** `src/auth/middleware.ts` is a Hono middleware on `/mcp`, switched on with `AUTH_REQUIRED=1` (off by default until 9.4). It verifies signature (keys fetched from the issuer's `/jwks.json` and cached), issuer, expiry and that `aud` is this server (`MCP_SERVER_URL`). No header: `401` with `resource_metadata` and `scope`. Malformed header: `400 invalid_request`. Bad, expired or wrong-audience token: `401 invalid_token`. Issuer unreachable: `503`. On success the caller (`sub`, `scope`) is put on the request context for Stage 10. D4 decided: our own middleware, not the SDK's Express one. 12 unit tests plus 4 end-to-end tests against the real server and a real issuer; removing the audience check fails 2 of them.

```bash
pnpm build
pnpm issuer serve                                   # http://localhost:4769, keys in .auth/ (git-ignored)
pnpm issuer token --sub alice --scope "mcp:tools"   # prints a token for http://localhost:4768/mcp
curl localhost:4769/jwks.json                       # the public key; the private key never leaves the file
```

Seven tests cover it: a good token verifies; a wrong key, audience, issuer or expired time is refused; the JWKS has no private part; the key file is 0600 and reused between runs.

**Config in a `.env` per package.** Ports and addresses were spread over code defaults and `package.json` flags. Each of `packages/server`, `packages/client` and `packages/web` now has a committed `.env.example` and a git-ignored `.env`. `cp` each template. The server, issuer and client scripts load it with `node --env-file-if-exists=.env`, because Node never reads `.env` itself. The dashboard reads its own file through Next.js, and `packages/web/scripts/next.mjs` takes `WEB_PORT` from it. Shell variables beat the file and flags beat both; the built-in defaults are unchanged, so no `.env` still works. It started as one root file, then was split. Checked by running the server, issuer, client and dashboard on 5767 to 5769 from changed per-package files.
