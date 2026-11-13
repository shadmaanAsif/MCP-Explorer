import { createLocalJWKSet, SignJWT } from 'jose';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { bearerAuth, type AuthInfo } from '../src/auth/middleware.js';
import { createKeys, createToken, type IssuerKeys } from '../src/auth/issuer.js';

const ISSUER = 'http://issuer.test';
const AUDIENCE = 'http://localhost:4768/mcp';
const META = 'http://localhost:4768/.well-known/oauth-protected-resource/mcp';

async function setup() {
  const keys = await createKeys();
  const app = new Hono<{ Variables: { auth: AuthInfo } }>();
  app.use(
    '/mcp',
    bearerAuth({
      issuer: ISSUER,
      audience: AUDIENCE,
      resourceMetadataUrl: META,
      scope: 'mcp:tools',
      keys: createLocalJWKSet({ keys: [keys.publicJwk] }),
    }),
  );
  app.all('/mcp', (c) => c.json({ ok: true, auth: c.get('auth') }));
  app.get('/health', (c) => c.text('ok'));
  app.get('/.well-known/x', (c) => c.text('open'));
  const token = (k: IssuerKeys = keys, o: Partial<Parameters<typeof createToken>[1]> = {}) =>
    createToken(k, { issuer: ISSUER, subject: 'alice', audience: AUDIENCE, scope: 'mcp:tools review:run', ...o });
  const call = (headers: Record<string, string> = {}, path = '/mcp') => app.request(path, { headers });
  return { keys, token, call };
}

describe('bearer middleware (Stage 9.3)', () => {
  it('no Authorization header: 401 with resource_metadata and scope', async () => {
    const { call } = await setup();
    const res = await call();
    expect(res.status).toBe(401);
    const h = res.headers.get('www-authenticate')!;
    expect(h).toContain(`resource_metadata="${META}"`);
    expect(h).toContain('scope="mcp:tools"');
    expect(h).not.toContain('error=');
  });

  it.each(['Basic abc', 'Bearer', 'Bearer a b', 'abc'])('malformed header %j: 400 invalid_request', async (value) => {
    const { call } = await setup();
    const res = await call({ authorization: value });
    expect(res.status).toBe(400);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_request"');
  });

  it('a token signed by a different key: 401 invalid_token', async () => {
    const { call, token } = await setup();
    const res = await call({ authorization: `Bearer ${await token(await createKeys())}` });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('an expired token: 401 invalid_token', async () => {
    const { call, keys } = await setup();
    const expired = await new SignJWT({ scope: 'mcp:tools' })
      .setProtectedHeader({ alg: 'RS256', kid: keys.publicJwk.kid })
      .setIssuer(ISSUER)
      .setSubject('alice')
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(keys.privateKey);
    const res = await call({ authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('a token made for another audience: 401 invalid_token', async () => {
    const { call, token, keys } = await setup();
    const res = await call({ authorization: `Bearer ${await token(keys, { audience: 'http://other.example/mcp' })}` });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('a token from another issuer: 401 invalid_token', async () => {
    const { call, token, keys } = await setup();
    const res = await call({ authorization: `Bearer ${await token(keys, { issuer: 'http://evil.example' })}` });
    expect(res.status).toBe(401);
  });

  it('a valid token passes and the caller reaches the handler', async () => {
    const { call, token } = await setup();
    const res = await call({ authorization: `Bearer ${await token()}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, auth: { subject: 'alice', scopes: ['mcp:tools', 'review:run'] } });
  });

  it('a token in the query string is ignored: same as no token', async () => {
    const { call, token } = await setup();
    const res = await call({}, `/mcp?access_token=${await token()}`);
    expect(res.status).toBe(401);
  });

  it('routes outside /mcp stay open', async () => {
    const { call } = await setup();
    expect((await call({}, '/health')).status).toBe(200);
    expect((await call({}, '/.well-known/x')).status).toBe(200);
  });
});
