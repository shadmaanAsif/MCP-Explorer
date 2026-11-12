import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { type IssuerKeys, createKeys, createToken, issuerApp, loadOrCreateKeys } from '../src/auth/issuer.js';

const ISSUER = 'http://issuer.test';
const AUDIENCE = 'http://localhost:4768/mcp';

/** What a resource server does: fetch the published keys, then verify. */
async function jwksFrom(keys: IssuerKeys) {
  const res = await issuerApp(keys, ISSUER).request('/jwks.json');
  return createLocalJWKSet(await res.json());
}

describe('token issuer', () => {
  it('signs a token that verifies against the published JWKS', async () => {
    const keys = await createKeys();
    const token = await createToken(keys, { issuer: ISSUER, subject: 'alice', audience: AUDIENCE, scope: 'mcp:tools' });
    const { payload } = await jwtVerify(token, await jwksFrom(keys), { issuer: ISSUER, audience: AUDIENCE });
    expect(payload.sub).toBe('alice');
    expect(payload.scope).toBe('mcp:tools');
  });

  it('is refused when signed by a different key', async () => {
    const token = await createToken(await createKeys(), { issuer: ISSUER, subject: 'mallory', audience: AUDIENCE });
    await expect(jwtVerify(token, await jwksFrom(await createKeys()), { issuer: ISSUER, audience: AUDIENCE })).rejects.toThrow();
  });

  it('is refused for another audience', async () => {
    const keys = await createKeys();
    const token = await createToken(keys, { issuer: ISSUER, subject: 'alice', audience: 'http://other.test/mcp' });
    await expect(jwtVerify(token, await jwksFrom(keys), { issuer: ISSUER, audience: AUDIENCE })).rejects.toThrow(/"aud"/);
  });

  it('is refused for another issuer', async () => {
    const keys = await createKeys();
    const token = await createToken(keys, { issuer: 'http://evil.test', subject: 'alice', audience: AUDIENCE });
    await expect(jwtVerify(token, await jwksFrom(keys), { issuer: ISSUER, audience: AUDIENCE })).rejects.toThrow(/"iss"/);
  });

  it('is refused once expired', async () => {
    const keys = await createKeys();
    const token = await createToken(keys, { issuer: ISSUER, subject: 'alice', audience: AUDIENCE, ttlSeconds: -10 });
    await expect(jwtVerify(token, await jwksFrom(keys), { issuer: ISSUER, audience: AUDIENCE })).rejects.toThrow(/"exp"/);
  });

  it('publishes metadata that points at its keys, and never the private key', async () => {
    const keys = await createKeys();
    const app = issuerApp(keys, ISSUER);
    const meta = await (await app.request('/.well-known/oauth-authorization-server')).json();
    expect(meta).toEqual({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks.json` });
    const jwks = JSON.stringify(await (await app.request('/jwks.json')).json());
    expect(jwks).not.toContain('"d"'); // "d" is the private exponent in an RSA JWK
  });

  it('keeps the same key between runs, in a file only the owner can read', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'issuer-')), 'key.json');
    const first = await loadOrCreateKeys(file);
    const second = await loadOrCreateKeys(file);
    expect(second.publicJwk.kid).toBe(first.publicJwk.kid);
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(await readFile(file, 'utf8')).toContain('privateJwk');
    // A token signed with the first load verifies with the key loaded the second time.
    const token = await createToken(first, { issuer: ISSUER, subject: 'a', audience: AUDIENCE });
    await jwtVerify(token, await jwksFrom(second), { issuer: ISSUER, audience: AUDIENCE });
  });
});
