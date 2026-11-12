# Plan: Stage 9, authentication

**Phase 2, stage 1 of 5.** Branch: `17-stage-9-authentication`. Status: planned, not started.

## Goal

The HTTP server knows who is calling. A request to `/mcp` without a valid token gets `401`, and the `401` tells the client where to find out how to get one. This is the MCP authorization model: the server is an OAuth 2.1 **resource server**. It checks tokens. It does not issue them or show a login page.

## You can do this when it's done

Start the server with auth on. `curl` to `/mcp` returns `401` with a `WWW-Authenticate` header. Run the issuer script to get a token, send it, and the call works. A token that is expired, signed by someone else, or meant for another server is refused.

## What the MCP spec asks of a server

Checked at step 9.1 against the current spec, version **2026-07-28** ([authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) and its [discovery page](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)). The first draft of this list came from memory of 2025-06-18 and had three mistakes, fixed below.

- Authorization is optional. For HTTP a server SHOULD follow the spec; **stdio servers SHOULD NOT**, they take credentials from the environment. So stdio is untouched.
- The server is an OAuth 2.1 **resource server**. It MUST implement protected resource metadata (RFC 9728), and the document MUST list at least one `authorization_servers` entry. *(Draft said "the issuer"; the field is `authorization_servers`.)*
- Discovery: a server MUST do **one** of (a) put `resource_metadata="<url>"` in the `WWW-Authenticate` header of a `401`, or (b) serve the metadata at a well-known URI, either `/.well-known/oauth-protected-resource` or the path form `/.well-known/oauth-protected-resource/mcp`. We do both. *(Draft said both were required.)*
- A `401` SHOULD also carry `scope="…"`, the scopes the request needs.
- Tokens: `Authorization: Bearer <token>` on every request, never in the query string. The server MUST validate the token and that its **audience** is this server (RFC 8707). Invalid or expired token: `401`. The server MUST NOT accept or pass on any other token.
- Status codes: `401` token missing or invalid, `403` insufficient scope (Stage 10), `400` malformed request. *(Draft had a malformed header as `401`; the spec table says `400`.)*

## Decisions

| # | Decision | Choice | Status |
|---|---|---|---|
| D1 | Who issues tokens | A small issuer in the repo (`src/auth/issuer.ts`) signing JWTs with `jose`, run with `pnpm issuer` | **built (9.1)** |
| D2 | Signature type | RS256 with a JWKS endpoint, so the server fetches public keys the way it would from a real provider | **built (9.1)** |
| D3 | Auth on by default? | **Off** by default (`AUTH_REQUIRED=1` turns it on) until 9.4 teaches the CLI client and dashboard to send a token. Phase 2 ends with it on. | agreed |
| D4 | Use the SDK's bearer middleware or write our own | Decide at 9.3. The SDK ships `requireBearerAuth` under `server/auth/middleware`, but I have not checked that it works with Hono, and the server is Hono since Stage 7. | open |
| D5 | Which routes are open | `/.well-known/*` and `/health` open; `/mcp` protected | proposed |

## Steps

**9.1 Read the spec and write the token issuer. (done)**
Spec checked (list above). Added `jose` to the server package, `packages/server/src/auth/issuer.ts` (RS256 key pair saved to `.auth/issuer-key.json`, mode 0600 and git-ignored; `createToken`; an app serving `/.well-known/oauth-authorization-server` and `/jwks.json`) and `issuer-cli.ts`:
`pnpm issuer serve` (port 4769) and `pnpm issuer token --sub alice --scope "a b" [--aud URL] [--ttl SECONDS]`.
*Done when:* a token verifies against the issuer's published JWKS, and one with a wrong key, audience, issuer or an expired time is refused (7 tests in `auth-issuer.test.ts`). Met.

**9.2 Protected-resource metadata.**
Add `GET /.well-known/oauth-protected-resource` and the path form `/.well-known/oauth-protected-resource/mcp` to `http.ts`, returning the resource URL and `authorization_servers`.
*Done when:* a test fetches it and the JSON names this server and lists the issuer under `authorization_servers`.

**9.3 Bearer middleware.**
Hono middleware on `/mcp`: read `Authorization: Bearer`, verify signature, issuer, audience and expiry; on failure return `401` with `WWW-Authenticate` carrying `resource_metadata` and `scope`; on success attach the caller (`sub`, `scope`) to the request context. Behind `AUTH_REQUIRED`.
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
| No `Authorization` header | `401`, `WWW-Authenticate` with `resource_metadata` and `scope` |
| Malformed header (not `Bearer <token>`) | `400`, `error="invalid_request"` |
| Signed by a different key | `401`, `error="invalid_token"` |
| Expired token | `401`, `error="invalid_token"` |
| Wrong audience | `401`, `error="invalid_token"` |
| Valid token | works as before |
| Token in the query string | refused, same as no token |
| `/health`, `/.well-known/…` with no token | `200` |
| stdio server | unchanged |

## Risks

- With auth on, the dashboard and CLI stop working until 9.4. D3 (off by default) avoids breaking them in the meantime.
- Review tools over HTTP are still refused by default (Stage 8). Auth does not change that.
- JWKS fetching adds a network call; cache the keys and test a key rotation.

## Out of scope

Dynamic client registration, a login or consent page, a real identity provider, and per-tool scopes (that is Stage 10).
