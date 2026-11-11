# Plan: Stage 9, authentication

**Phase 2, stage 1 of 5.** Branch: `17-stage-9-authentication`. Status: planned, not started.

## Goal

The HTTP server knows who is calling. A request to `/mcp` without a valid token gets `401`, and the `401` tells the client where to find out how to get one. This is the MCP authorization model: the server is an OAuth 2.1 **resource server**. It checks tokens. It does not issue them or show a login page.

## You can do this when it's done

Start the server with auth on. `curl` to `/mcp` returns `401` with a `WWW-Authenticate` header. Run the issuer script to get a token, send it, and the call works. A token that is expired, signed by someone else, or meant for another server is refused.

## What the MCP spec asks of a server (to verify at 9.1)

Written from memory of the 2025-06-18 authorization spec. Read the current spec text at step 9.1 and correct this list before building.

- Serve **protected resource metadata** (RFC 9728) at `/.well-known/oauth-protected-resource`, naming the authorization server(s).
- On `401`, send `WWW-Authenticate: Bearer resource_metadata="<url>"`.
- Accept tokens only if their **audience** is this server (RFC 8707 resource indicators), and never pass a received token on to another API.
- This applies to HTTP only. stdio servers take credentials from the environment, so stdio is untouched.

## Decisions

| # | Decision | Choice | Status |
|---|---|---|---|
| D1 | Who issues tokens | A small script in the repo, signing JWTs with `jose` | proposed |
| D2 | Signature type | RS256 with a JWKS endpoint, so the server fetches public keys the way it would from a real provider | proposed |
| D3 | Auth on by default? | **Off** by default (`AUTH_REQUIRED=1` turns it on) until 9.4 teaches the CLI client and dashboard to send a token. Phase 2 ends with it on. | proposed |
| D4 | Use the SDK's bearer middleware or write our own | Decide at 9.3. The SDK ships `requireBearerAuth` under `server/auth/middleware`, but I have not checked that it works with Hono, and the server is Hono since Stage 7. | open |
| D5 | Which routes are open | `/.well-known/*` and `/health` open; `/mcp` protected | proposed |

## Steps

**9.1 Read the spec and write the token issuer.**
Confirm the list above against the spec. Add `packages/server/scripts/issuer.ts` (key pair, JWKS endpoint, `issue --sub --scope --aud --ttl` command). Add `jose` to the server package.
*Done when:* the script prints a token that `jose` verifies against its own JWKS, and the spec list is corrected in this file.

**9.2 Protected-resource metadata.**
Add `GET /.well-known/oauth-protected-resource` to `http.ts` returning the resource URL and the issuer.
*Done when:* a test fetches it and the JSON names this server and the issuer.

**9.3 Bearer middleware.**
Hono middleware on `/mcp`: read `Authorization: Bearer`, verify signature, issuer, audience and expiry; on failure return `401` with `WWW-Authenticate` and the metadata URL; on success attach the caller (`sub`, `scope`) to the request context. Behind `AUTH_REQUIRED`.
*Done when:* every row of the table below is a passing test.

**9.4 Client side.**
The CLI client and the web dashboard send a token (from an env var), and the client reports a `401` with the metadata URL rather than a bare failure.
*Done when:* with auth on, `pnpm client` and the dashboard work with a token and show a clear message without one.

**9.5 Tests and docs.**
Contract and HTTP tests, a mutation check (remove the audience check, a test must fail), `docs/branches/17-stage-9-authentication.md`, `docs/connecting-clients.md` section on tokens, README row, artifact.
*Done when:* CI green and the branch doc matches what was built.

## Behaviour to prove (9.3)

| Request to `/mcp` | Result |
|---|---|
| No `Authorization` header | `401`, `WWW-Authenticate` with `resource_metadata` |
| Malformed header | `401`, `error="invalid_request"` |
| Signed by a different key | `401`, `error="invalid_token"` |
| Expired token | `401`, `error="invalid_token"` |
| Wrong audience | `401`, `error="invalid_token"` |
| Valid token | works as before |
| `/health`, `/.well-known/…` with no token | `200` |
| stdio server | unchanged |

## Risks

- With auth on, the dashboard and CLI stop working until 9.4. D3 (off by default) avoids breaking them in the meantime.
- Review tools over HTTP are still refused by default (Stage 8). Auth does not change that.
- JWKS fetching adds a network call; cache the keys and test a key rotation.

## Out of scope

Dynamic client registration, a login or consent page, a real identity provider, and per-tool scopes (that is Stage 10).
