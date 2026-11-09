import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
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
