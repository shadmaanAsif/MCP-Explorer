// The guard in front of /mcp. For every request it reads the Bearer token,
// checks it came from our issuer, is not expired and was made for THIS
// server (audience), then lets the request through. Otherwise it answers
// 401 or 400 with a WWW-Authenticate header that says where to get a token.
import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AuthInfo {
  /** Who the token is for (`sub`). */
  subject: string;
  /** The scopes it carries, split on spaces. Stage 10 decides what they allow. */
  scopes: string[];
}

export interface BearerAuthOptions {
  /** Expected `iss`, e.g. http://localhost:4769. */
  issuer: string;
  /** Expected `aud`: this server's own address. A token made for another server is refused. */
  audience: string;
  /** Where the protected-resource metadata lives; sent in WWW-Authenticate so a client can find the issuer. */
  resourceMetadataUrl: string;
  /** Scope advertised in WWW-Authenticate. Not enforced until Stage 10. */
  scope?: string;
  /** Where signing keys come from. Default: the issuer's /jwks.json, fetched and cached. Tests pass a local set. */
  keys?: JWTVerifyGetKey;
}

function challenge(options: BearerAuthOptions, error?: { code: string; description: string }): string {
  const parts = [`resource_metadata="${options.resourceMetadataUrl}"`];
  if (options.scope) parts.push(`scope="${options.scope}"`);
  if (error) parts.push(`error="${error.code}"`, `error_description="${error.description}"`);
  return `Bearer ${parts.join(', ')}`;
}

// Fetching the issuer's keys failed (down, slow, bad answer): that is not the
// caller's fault, so it is a 503 and not a 401.
const isBadToken = (err: unknown) =>
  err instanceof errors.JOSEError && !(err instanceof errors.JWKSTimeout);

export function bearerAuth(options: BearerAuthOptions): MiddlewareHandler<{ Variables: { auth: AuthInfo } }> {
  const keys = options.keys ?? createRemoteJWKSet(new URL('/jwks.json', options.issuer));

  return async (c, next) => {
    const header = c.req.header('authorization');

    // No credentials at all: tell the client where to start (RFC 9728).
    if (!header) {
      return c.body(null, 401, { 'WWW-Authenticate': challenge(options) });
    }

    // Something is there but it is not "Bearer <token>": a malformed request, not a bad token.
    const match = /^Bearer ([^\s]+)$/i.exec(header);
    if (!match) {
      return c.body(null, 400, {
        'WWW-Authenticate': challenge(options, {
          code: 'invalid_request',
          description: 'Authorization must be "Bearer <token>"',
        }),
      });
    }

    try {
      const { payload } = await jwtVerify(match[1], keys, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ['RS256'],
      });
      c.set('auth', {
        subject: String(payload.sub ?? ''),
        scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
      });
    } catch (err) {
      if (isBadToken(err)) {
        return c.body(null, 401, {
          'WWW-Authenticate': challenge(options, { code: 'invalid_token', description: 'The token is invalid or expired' }),
        });
      }
      console.error('[mcp-demo] could not check token (issuer keys unavailable?):', err);
      return c.body(null, 503, { 'Retry-After': '5' });
    }
    await next();
  };
}
