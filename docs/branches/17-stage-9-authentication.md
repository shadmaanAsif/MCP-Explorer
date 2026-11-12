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

```bash
pnpm build
pnpm issuer serve                                   # http://localhost:4769, keys in .auth/ (git-ignored)
pnpm issuer token --sub alice --scope "mcp:tools"   # prints a token for http://localhost:4768/mcp
curl localhost:4769/jwks.json                       # the public key; the private key never leaves the file
```

Seven tests cover it: a good token verifies; a wrong key, audience, issuer or expired time is refused; the JWKS has no private part; the key file is 0600 and reused between runs.

**Config in one `.env` file.** Ports and addresses were spread over code defaults and `package.json` flags. They are now listed in [`.env.example`](../../.env.example): `MCP_SERVER_PORT`, `WEB_PORT`, `ISSUER_PORT`, `MCP_SERVER_URL`, `ISSUER_URL`, `TOKEN_AUDIENCE`, `TOKEN_TTL_SECONDS` and more. `cp .env.example .env` (git-ignored). The scripts load it with `node --env-file-if-exists=../../.env`; the dashboard uses a small wrapper, `packages/web/scripts/next.mjs`, because Next only reads `.env` files inside its own package. Shell variables beat the file and flags beat both; the built-in defaults are unchanged, so no `.env` still works. Checked by running all three processes on 5767 to 5769 from a changed `.env`.
