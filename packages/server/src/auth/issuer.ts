// A tiny stand-in for an identity provider, for learning and tests.
//
// A real server would trust Auth0, Okta, Keycloak and so on. This issuer does
// the same two jobs they do for a resource server: it signs tokens with a
// private key, and it publishes the matching public key (a JWKS) so the
// server can check signatures without ever holding the private key.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';

export const DEFAULT_ISSUER = 'http://localhost:4769';
export const DEFAULT_KEY_FILE = '.auth/issuer-key.json';

export interface IssuerKeys {
  privateKey: CryptoKey;
  /** The public half, in the form published at the JWKS endpoint. */
  publicJwk: JWK;
}

interface StoredKey {
  privateJwk: JWK;
  publicJwk: JWK;
}

/** Load the issuer's key pair from `file`, creating and saving one the first time. */
export async function loadOrCreateKeys(file: string = DEFAULT_KEY_FILE): Promise<IssuerKeys> {
  try {
    const stored = JSON.parse(await readFile(file, 'utf8')) as StoredKey;
    return {
      privateKey: (await importJWK(stored.privateJwk, 'RS256')) as CryptoKey,
      publicJwk: stored.publicJwk,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const keys = await createKeys();
  await saveKeys(keys, file);
  return keys;
}

/** A fresh in-memory key pair. Tests use this; nothing touches the disk. */
export async function createKeys(): Promise<IssuerKeys & { privateJwk: JWK }> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  // A key id lets a server pick the right key when the issuer rotates keys.
  publicJwk.kid = privateJwk.kid = `key-${Date.now().toString(36)}`;
  publicJwk.alg = privateJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  return { privateKey, publicJwk, privateJwk };
}

async function saveKeys(keys: IssuerKeys & { privateJwk?: JWK }, file: string): Promise<void> {
  const privateJwk = keys.privateJwk ?? (await exportJWK(keys.privateKey));
  await mkdir(dirname(file), { recursive: true });
  const body: StoredKey = { privateJwk, publicJwk: keys.publicJwk };
  // 0600: the private key must not be readable by other users.
  await writeFile(file, JSON.stringify(body, null, 2), { mode: 0o600 });
}

export interface TokenOptions {
  issuer?: string;
  subject: string;
  /** The MCP server this token is for (RFC 8707). A server must refuse tokens meant for another. */
  audience: string;
  scope?: string;
  ttlSeconds?: number;
}

export async function createToken(keys: IssuerKeys, options: TokenOptions): Promise<string> {
  const { issuer = DEFAULT_ISSUER, subject, audience, scope = '', ttlSeconds = 3600 } = options;
  const kid = keys.publicJwk.kid;
  return await new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', ...(kid ? { kid } : {}) })
    .setIssuer(issuer)
    .setSubject(subject)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(keys.privateKey);
}

/** The issuer's public endpoints: its metadata and its signing keys. */
export function issuerApp(keys: IssuerKeys, issuer: string = DEFAULT_ISSUER): Hono {
  const app = new Hono();
  // RFC 8414 authorization server metadata: how a client finds the issuer's endpoints.
  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({ issuer, jwks_uri: `${issuer}/jwks.json` }),
  );
  app.get('/jwks.json', (c) => c.json({ keys: [keys.publicJwk] }));
  return app;
}
