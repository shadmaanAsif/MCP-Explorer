import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { serve } from '@hono/node-server';
import { createKeys, createToken, issuerApp } from '../src/auth/issuer.js';
import { startHttpServer, type HttpServer } from './helpers/http-server.js';
import { startWeatherStub, type WeatherStub } from './helpers/stub-weather.js';

// These start the real compiled server (build/http.js) as a child process and
// talk to it over HTTP, so they cover what in-memory tests can't: the
// Mcp-Session-Id routing, the status codes, cancel delivery and the idle sweep.

let stub: WeatherStub;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw', version: '0' } }
};

async function connect(url: string) {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, transport };
}

beforeAll(async () => {
  stub = await startWeatherStub();
});
afterAll(async () => {
  await stub.close();
});
beforeEach(() => {
  stub.mode = 'ok';
  stub.hits = 0;
  stub.closed = 0;
});

const weatherEnv = () => ({
  OPEN_METEO_URL: stub.url,
  WEATHER_FETCH_TIMEOUT_MS: '600',
  WEATHER_RETRY_BASE_DELAY_MS: '10'
});

describe('stateful mode (default)', () => {
  let server: HttpServer;
  beforeAll(async () => {
    server = await startHttpServer({ ...weatherEnv(), MCP_MODE: 'stateful', MCP_SESSION_TTL_MS: '600' });
  });
  afterAll(() => server.stop());

  it('returns 404 for any path other than /mcp', async () => {
    const res = await fetch(server.url.replace('/mcp', '/other'), { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('issues an Mcp-Session-Id on initialize', async () => {
    const res = await fetch(server.url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(initializeBody) });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toMatch(/^[0-9a-f-]{36}$/);
    await res.text();
  });

  it('answers 400 to a non-initialize POST with no session id', async () => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    expect(res.status).toBe(400);
  });

  it('answers 400 to a GET with no session id', async () => {
    const res = await fetch(server.url, { method: 'GET', headers: { Accept: 'text/event-stream' } });
    expect(res.status).toBe(400);
  });

  it('answers 404 "Session not found" for an unknown session id', async () => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Mcp-Session-Id': 'does-not-exist' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe('Session not found');
  });

  it('remembers state across calls in one session', async () => {
    const { client } = await connect(server.url);
    try {
      await client.callTool({ name: 'set_home_location', arguments: { name: 'Home', latitude: 1, longitude: 2 } });
      expect(textOf(await client.callTool({ name: 'get_home_weather', arguments: {} }))).toBe('Home: 12.3°C, wind 4.5 km/h');
    } finally {
      await client.close();
    }
  });

  it('keeps two clients separate', async () => {
    const a = await connect(server.url);
    const b = await connect(server.url);
    try {
      expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
      await a.client.callTool({ name: 'set_home_location', arguments: { name: 'A', latitude: 1, longitude: 1 } });
      const result = await b.client.callTool({ name: 'get_home_weather', arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  it('ends a session on terminateSession, after which its id gets 404', async () => {
    const { client, transport } = await connect(server.url);
    const id = transport.sessionId!;
    await transport.terminateSession();
    await client.close();
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Mcp-Session-Id': id },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    expect(res.status).toBe(404);
  });

  it('delivers a client cancel to the running call, which stops the upstream request', async () => {
    stub.mode = 'hang';
    const { client } = await connect(server.url);
    try {
      const controller = new AbortController();
      const call = client
        .callTool({ name: 'get_weather', arguments: { latitude: 0, longitude: 0 } }, undefined, { signal: controller.signal })
        .catch((e) => e);
      await expect.poll(() => stub.hits).toBe(1);
      controller.abort();
      await call;
      // The cancel reaches the same session's server, so the upstream connection
      // drops right away (well before the 600ms timeout) and nothing retries.
      await expect.poll(() => stub.closed, { timeout: 400 }).toBe(1);
      await sleep(900);
      expect(stub.hits).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('closes an idle session but keeps one that stays busy', async () => {
    const idle = await connect(server.url);
    const busy = await connect(server.url);
    try {
      const idleId = idle.transport.sessionId!;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        await busy.client.listTools(); // keeps this session's lastSeen fresh
        await sleep(100);
      }
      const gone = await fetch(server.url, {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'Mcp-Session-Id': idleId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
      });
      expect(gone.status).toBe(404);
      expect((await busy.client.listTools()).tools.length).toBeGreaterThan(0);
      expect(server.logs()).toContain('idle for over 600ms, closing');
    } finally {
      await busy.client.close();
      await idle.client.close().catch(() => {});
    }
  });
});

describe('stateless mode', () => {
  let server: HttpServer;
  beforeAll(async () => {
    server = await startHttpServer({ ...weatherEnv(), MCP_MODE: 'stateless' });
  });
  afterAll(() => server.stop());

  it('answers 405 with Allow: POST to a GET', async () => {
    const res = await fetch(server.url, { method: 'GET', headers: { Accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('issues no session id', async () => {
    const res = await fetch(server.url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(initializeBody) });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    await res.text();
  });

  it('serves tools, and streams batch progress on the same request', async () => {
    const { client } = await connect(server.url);
    try {
      expect(textOf(await client.callTool({ name: 'add', arguments: { a: 1, b: 2 } }))).toBe('3');
      const updates: number[] = [];
      await client.callTool(
        { name: 'get_weather_batch', arguments: { locations: [
          { name: 'A', latitude: 0, longitude: 0 },
          { name: 'B', latitude: 1, longitude: 1 }
        ] } },
        undefined,
        { onprogress: (p) => updates.push(p.progress) }
      );
      expect(updates).toEqual([1, 2]);
    } finally {
      await client.close();
    }
  });

  it('forgets session state between calls', async () => {
    const { client } = await connect(server.url);
    try {
      await client.callTool({ name: 'set_home_location', arguments: { name: 'Home', latitude: 1, longitude: 2 } });
      const result = await client.callTool({ name: 'get_home_weather', arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('cannot deliver a cancel: the upstream call runs to the server timeout, then retries', async () => {
    stub.mode = 'hang';
    const { client } = await connect(server.url);
    try {
      const controller = new AbortController();
      const call = client
        .callTool({ name: 'get_weather', arguments: { latitude: 0, longitude: 0 } }, undefined, { signal: controller.signal })
        .catch((e) => e);
      await expect.poll(() => stub.hits).toBe(1);
      controller.abort();
      await call;
      await sleep(250); // far short of the 600ms timeout
      expect(stub.closed).toBe(0); // the cancel did not stop the upstream request
      await expect.poll(() => stub.hits, { timeout: 1500 }).toBeGreaterThanOrEqual(2); // timeout fired, retry started
    } finally {
      await client.close();
    }
  });
});

// The HTTP layer is Hono (Stage 7): these cover what only the router and its
// middleware do, in both modes.
describe.each(['stateful', 'stateless'] as const)('HTTP layer (%s)', (mode) => {
  let server: HttpServer;
  beforeAll(async () => {
    server = await startHttpServer({ ...weatherEnv(), MCP_MODE: mode });
  });
  afterAll(() => server.stop());

  it('answers an unknown path with an empty 404', async () => {
    const res = await fetch(server.url.replace('/mcp', '/nope'), { method: 'GET' });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('answers a malformed JSON body with a JSON-RPC 500 and keeps serving', async () => {
    const bad = await fetch(server.url, { method: 'POST', headers: JSON_HEADERS, body: '{not json' });
    expect(bad.status).toBe(500);
    expect(await bad.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32603 } });

    const { client } = await connect(server.url);
    expect(textOf(await client.callTool({ name: 'add', arguments: { a: 1, b: 2 } }))).toBe('3');
    await client.close();
  });

  it('logs every request through the middleware', async () => {
    const { client } = await connect(server.url);
    await client.listTools();
    await client.close();
    expect(server.logs()).toMatch(/POST \/mcp 200 \d+ms/);
  });
});

// Stage 8: run_checks starts a real child process, so cancel matters twice
// over here. A cancel only reaches the running call when the session keeps one
// server (stateful); in stateless mode the check runs to its natural end.
describe.each([
  { mode: 'stateful', cancelStops: true },
  { mode: 'stateless', cancelStops: false }
] as const)('run_checks cancel over HTTP (%s)', ({ mode, cancelStops }) => {
  let server: HttpServer;
  let repo: string;
  beforeAll(async () => {
    repo = mkdtempSync(path.join(tmpdir(), 'review-http-'));
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'node slow.js' } }));
    // Records its pid, then finishes by itself after 1.5s and leaves a marker.
    writeFileSync(
      path.join(repo, 'slow.js'),
      "const fs=require('fs');fs.writeFileSync('pid.txt',String(process.pid));setTimeout(()=>fs.writeFileSync('done.txt','done'),1500);"
    );
    server = await startHttpServer({ ...weatherEnv(), MCP_MODE: mode, REVIEW_ROOT: repo, REVIEW_ALLOW_HTTP: '1' });
  });
  afterAll(async () => {
    await server.stop();
    rmSync(repo, { recursive: true, force: true });
  });

  it(cancelStops ? 'stops the running check' : 'cannot stop the running check: it finishes on its own', async () => {
    rmSync(path.join(repo, 'pid.txt'), { force: true });
    rmSync(path.join(repo, 'done.txt'), { force: true });
    const { client } = await connect(server.url);
    try {
      const controller = new AbortController();
      const call = client
        .callTool({ name: 'run_checks', arguments: { checks: ['build'] } }, undefined, { signal: controller.signal })
        .catch((e) => e);
      await expect.poll(() => existsSync(path.join(repo, 'pid.txt')), { timeout: 5000 }).toBe(true);
      controller.abort();
      await call;
      await sleep(2200); // longer than the check's own 1.5s
      expect(existsSync(path.join(repo, 'done.txt'))).toBe(!cancelStops);
      if (cancelStops) {
        const pid = Number(readFileSync(path.join(repo, 'pid.txt'), 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow(); // the process is gone
      }
    } finally {
      await client.close().catch(() => {});
    }
  });
});

// A shared HTTP server must not guess which repo to review: with no project
// named, review tools fail unless the operator opts out.
describe('review tools on a shared HTTP server (admin opted in)', () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'review-shared-'));
    writeFileSync(path.join(repo, 'hello.txt'), 'hello from the named project\n');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const baseEnv = () => {
    const env = { ...weatherEnv(), MCP_MODE: 'stateful', REVIEW_ALLOW_HTTP: '1' } as Record<string, string>;
    // The child inherits this process's env; make sure no pin leaks in.
    return { ...env, REVIEW_ROOT: '', REVIEW_ALLOWED_ROOTS: '', REVIEW_REQUIRE_ROOT: '' };
  };

  async function readFile(server: HttpServer, args: Record<string, unknown>) {
    const { client } = await connect(server.url);
    try {
      return await client.callTool({ name: 'read_file', arguments: { path: 'hello.txt', ...args } });
    } finally {
      await client.close().catch(() => {});
    }
  }
  const isErr = (r: unknown) => (r as { isError?: boolean }).isError === true;

  it('refuses a call that names no project (the default)', async () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>).REVIEW_REQUIRE_ROOT;
    delete (env as Record<string, string | undefined>).REVIEW_ROOT;
    delete (env as Record<string, string | undefined>).REVIEW_ALLOWED_ROOTS;
    const server = await startHttpServer(env);
    try {
      const r = await readFile(server, {});
      expect(isErr(r)).toBe(true);
      expect(textOf(r)).toContain('Pass `root`');
    } finally {
      await server.stop();
    }
  });

  it('serves the project the call names', async () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>).REVIEW_REQUIRE_ROOT;
    delete (env as Record<string, string | undefined>).REVIEW_ROOT;
    delete (env as Record<string, string | undefined>).REVIEW_ALLOWED_ROOTS;
    const server = await startHttpServer(env);
    try {
      const r = await readFile(server, { root: repo });
      expect(isErr(r)).toBe(false);
      expect(textOf(r)).toContain('hello from the named project');
    } finally {
      await server.stop();
    }
  });

  it('allows the start-folder fallback when REVIEW_REQUIRE_ROOT=0', async () => {
    const env = { ...baseEnv(), REVIEW_REQUIRE_ROOT: '0' };
    delete (env as Record<string, string | undefined>).REVIEW_ROOT;
    delete (env as Record<string, string | undefined>).REVIEW_ALLOWED_ROOTS;
    const server = await startHttpServer(env);
    try {
      // hello.txt is not in the server's own repo, so this is "not found",
      // not "no project": the fallback ran.
      const r = await readFile(server, {});
      expect(isErr(r)).toBe(true);
      expect(textOf(r)).not.toContain('Pass `root`');
    } finally {
      await server.stop();
    }
  });
});

// By default the HTTP server refuses the review tools, because they read the
// server's disk and not the client's project.
describe('review tools over HTTP by default', () => {
  let server: HttpServer;
  const refusal = /not available over HTTP[\s\S]*stdio[\s\S]*ask the server admin[\s\S]*REVIEW_ALLOW_HTTP=1/;
  beforeAll(async () => {
    const env = { ...weatherEnv(), MCP_MODE: 'stateful' } as Record<string, string | undefined>;
    server = await startHttpServer(env as Record<string, string>);
  });
  afterAll(() => server.stop());

  const call = async (name: string, args: Record<string, unknown>) => {
    const { client } = await connect(server.url);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close().catch(() => {});
    }
  };

  it.each([
    ['get_diff', { base: 'main' }],
    ['read_file', { path: 'package.json' }],
    ['run_checks', { checks: ['test'] }]
  ] as const)('%s returns a clear error that names stdio and the admin', async (name, args) => {
    const r = await call(name, { ...args });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(refusal);
  });

  it('refuses even when the call names a root, and starts no process', async () => {
    const r = await call('run_checks', { checks: ['test'], root: process.cwd() });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(refusal);
  });

  it('the prompt fails with the same message', async () => {
    const { client } = await connect(server.url);
    try {
      await expect(client.getPrompt({ name: 'review_code', arguments: { focus: 'bugs' } })).rejects.toThrow(refusal);
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('the resource lists nothing and reading it fails with the same message', async () => {
    const { client } = await connect(server.url);
    try {
      const listed = await client.listResources();
      expect(listed.resources.filter((r) => r.uri.startsWith('repo://'))).toEqual([]);
      await expect(client.readResource({ uri: 'repo://file/package.json' })).rejects.toThrow(refusal);
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('the weather tools still work on the same server', async () => {
    const r = await call('add', { a: 2, b: 3 });
    expect(textOf(r)).toBe('5');
  });
});

describe('protected resource metadata (Stage 9.2)', () => {
  let server: HttpServer;
  beforeAll(async () => {
    server = await startHttpServer({
      MCP_SERVER_URL: 'http://mcp.example/mcp',
      ISSUER_URL: 'http://issuer.example'
    });
  });
  afterAll(async () => {
    await server.stop();
  });

  const base = () => server.url.replace('/mcp', '');

  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])(
    'serves %s with no token',
    async (route) => {
      const res = await fetch(base() + route);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        resource: 'http://mcp.example/mcp',
        authorization_servers: ['http://issuer.example']
      });
    }
  );

  it('defaults to this server and the local issuer', async () => {
    const plain = await startHttpServer({ MCP_SERVER_URL: '', ISSUER_URL: '' });
    try {
      const doc = await (await fetch(plain.url.replace('/mcp', '/.well-known/oauth-protected-resource'))).json();
      expect(doc.resource).toBe(plain.url.replace('127.0.0.1', 'localhost'));
      expect(doc.authorization_servers).toEqual(['http://localhost:4769']);
    } finally {
      await plain.stop();
    }
  });
});

describe('bearer auth end to end (Stage 9.3)', () => {
  let server: HttpServer;
  let issuer: { close: () => void };
  let keys: Awaited<ReturnType<typeof createKeys>>;
  let issuerUrl: string;
  let audience: string;

  beforeAll(async () => {
    keys = await createKeys();
    // The issuer on a free port, so the server fetches its keys over HTTP like it would in real life.
    // The server only uses /jwks.json, so the app's own issuer string does not matter here.
    const app = issuerApp(keys);
    issuer = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: (r) => app.fetch(r), port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    issuerUrl = `http://127.0.0.1:${(issuer as unknown as { address(): { port: number } }).address().port}`;

    // The MCP server needs its own address as the audience, so pick the port first.
    server = await startHttpServer({ AUTH_REQUIRED: '1', ISSUER_URL: issuerUrl, MCP_SERVER_URL: '' });
    // The server's default audience is its own address written with localhost.
    audience = server.url.replace('127.0.0.1', 'localhost');
  });
  afterAll(async () => {
    issuer.close();
    await server.stop();
  });

  it('refuses a call with no token and points at the metadata', async () => {
    const res = await fetch(server.url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(initializeBody) });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('refuses a token made for another audience', async () => {
    const token = await createToken(keys, { issuer: issuerUrl, subject: 'alice', audience: 'http://other/mcp' });
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify(initializeBody),
    });
    expect(res.status).toBe(401);
  });

  it('lets a client with a valid token use the tools', async () => {
    const token = await createToken(keys, { issuer: issuerUrl, subject: 'alice', audience, scope: 'mcp:tools' });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it('keeps the metadata route open', async () => {
    const res = await fetch(server.url.replace('/mcp', '/.well-known/oauth-protected-resource'));
    expect(res.status).toBe(200);
  });
});
