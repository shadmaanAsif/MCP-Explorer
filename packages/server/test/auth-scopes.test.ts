import { createLocalJWKSet } from 'jose';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { bearerAuth, type AuthInfo } from '../src/auth/middleware.js';
import { requiredScope, scopeGuard, TOOL_SCOPES } from '../src/auth/scopes.js';
import { createKeys, createToken } from '../src/auth/issuer.js';

const ISSUER = 'http://issuer.test';
const AUDIENCE = 'http://localhost:4768/mcp';
const META = 'http://localhost:4768/.well-known/oauth-protected-resource/mcp';

async function setup() {
  const keys = await createKeys();
  const app = new Hono<{ Variables: { auth: AuthInfo } }>();
  app.use('/mcp', bearerAuth({ issuer: ISSUER, audience: AUDIENCE, resourceMetadataUrl: META, keys: createLocalJWKSet({ keys: [keys.publicJwk] }) }));
  app.use('/mcp', scopeGuard(META));
  // Reads the body again, like the real handlers do after the guard.
  app.post('/mcp', async (c) => c.json({ ok: true, body: await c.req.json() }));
  const call = async (scope: string, body: unknown) => {
    const token = await createToken(keys, { issuer: ISSUER, subject: 'alice', audience: AUDIENCE, scope });
    return app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };
  return { call };
}

const tool = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

describe('requiredScope', () => {
  it('maps tools, the review prompt and repo resources', () => {
    expect(requiredScope(tool('get_weather'))).toBe('weather:use');
    expect(requiredScope(tool('run_checks'))).toBe('review:run');
    expect(requiredScope({ method: 'prompts/get', params: { name: 'review_code' } })).toBe('review:read');
    expect(requiredScope({ method: 'resources/read', params: { uri: 'repo://file/a.ts' } })).toBe('review:read');
  });
  it('needs nothing for listing and initialize', () => {
    expect(requiredScope({ method: 'tools/list' })).toBeUndefined();
    expect(requiredScope({ method: 'initialize' })).toBeUndefined();
  });
  it('a tool that is not in the table is denied, not allowed', () => {
    expect(requiredScope(tool('brand_new_tool'))).toBe('tool:brand_new_tool');
  });
  it('every review tool is mapped', () => {
    expect(Object.keys(TOOL_SCOPES)).toEqual(expect.arrayContaining(['get_diff', 'read_file', 'run_checks']));
  });
});

describe('scope guard (Stage 10.1)', () => {
  it('lets a tool through when the token has its scope, and the body is still readable', async () => {
    const { call } = await setup();
    const res = await call('mcp:tools weather:use', tool('get_weather'));
    expect(res.status).toBe(200);
    expect((await res.json()).body.params.name).toBe('get_weather');
  });

  it('403 insufficient_scope naming the missing scope', async () => {
    const { call } = await setup();
    const res = await call('mcp:tools weather:use', tool('run_checks'));
    expect(res.status).toBe(403);
    const h = res.headers.get('www-authenticate')!;
    expect(h).toContain('error="insufficient_scope"');
    expect(h).toContain('scope="review:run"');
  });

  it('review:read does not allow run_checks', async () => {
    const { call } = await setup();
    expect((await call('mcp:tools review:read', tool('read_file'))).status).toBe(200);
    expect((await call('mcp:tools review:read', tool('run_checks'))).status).toBe(403);
  });

  it('a token without mcp:tools is refused even for listing', async () => {
    const { call } = await setup();
    const res = await call('weather:use', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(403);
  });

  it('listing needs only mcp:tools', async () => {
    const { call } = await setup();
    expect((await call('mcp:tools', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
  });

  it('a batch is refused if any message in it needs a missing scope', async () => {
    const { call } = await setup();
    const res = await call('mcp:tools weather:use', [tool('get_weather'), tool('run_checks')]);
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('scope="review:run"');
  });

  it('an unknown tool is refused', async () => {
    const { call } = await setup();
    expect((await call('mcp:tools weather:use review:run', tool('brand_new_tool'))).status).toBe(403);
  });
});
