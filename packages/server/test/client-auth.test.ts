import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { startHttpServer, type HttpServer } from './helpers/http-server.js';
import { createKeys, createToken, issuerApp } from '../src/auth/issuer.js';
import { connectToServer, AuthRequiredError } from '../../client/src/connection.js';

// Step 9.4: the client sends MCP_TOKEN, and a 401 turns into a message that
// says what to do. Runs against the real compiled server and a real issuer.
describe('client against a server with AUTH_REQUIRED=1 (Stage 9.4)', () => {
  let server: HttpServer;
  let issuer: { close: () => void };
  let keys: Awaited<ReturnType<typeof createKeys>>;
  let issuerUrl: string;
  let audience: string;

  beforeAll(async () => {
    keys = await createKeys();
    const app = issuerApp(keys);
    issuer = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: (r) => app.fetch(r), port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    issuerUrl = `http://127.0.0.1:${(issuer as unknown as { address(): { port: number } }).address().port}`;
    server = await startHttpServer({ AUTH_REQUIRED: '1', ISSUER_URL: issuerUrl, MCP_SERVER_URL: '' });
    audience = server.url.replace('127.0.0.1', 'localhost');
  });
  afterAll(async () => {
    issuer.close();
    await server.stop();
  });

  it('works with a valid token', async () => {
    const token = await createToken(keys, { issuer: issuerUrl, subject: 'alice', audience, scope: 'mcp:tools' });
    const client = await connectToServer(server.url, token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it('says a token is needed when none is set, and names the metadata URL', async () => {
    const err = await connectToServer(server.url, undefined).catch((e) => e);
    expect(err).toBeInstanceOf(AuthRequiredError);
    expect(err.message).toContain('MCP_TOKEN is not set');
    expect(err.message).toContain('pnpm issuer token');
    expect(err.metadataUrl).toContain('/.well-known/oauth-protected-resource');
  });

  it('says the token was refused when it is for another server', async () => {
    const token = await createToken(keys, { issuer: issuerUrl, subject: 'alice', audience: 'http://other/mcp' });
    const err = await connectToServer(server.url, token).catch((e) => e);
    expect(err).toBeInstanceOf(AuthRequiredError);
    expect(err.message).toContain('refused the token');
  });
});
