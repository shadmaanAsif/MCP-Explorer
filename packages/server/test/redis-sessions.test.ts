// Stage 11.2: sessions shared through real Redis, using the real compiled server.
// Skipped unless REDIS_URL is set (D6). Start Redis with:
//   docker run --rm -p 6379:6379 redis:7   then   REDIS_URL=redis://localhost:6379 pnpm test
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { startHttpServer, type HttpServer } from './helpers/http-server.js';
import { startWeatherStub, type WeatherStub } from './helpers/stub-weather.js';

const REDIS_URL = process.env.REDIS_URL;
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

// Answers come back as JSON or as a one-message SSE stream.
async function messageOf(res: Response): Promise<any> {
  const text = await res.text();
  const json = res.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').find((l) => l.startsWith('data:'))?.slice(5)
    : text;
  return json ? JSON.parse(json) : undefined;
}

async function open(url: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw', version: '0' } }
    })
  });
  const sessionId = res.headers.get('mcp-session-id')!;
  const version = (await messageOf(res)).result.protocolVersion as string;
  const headers = { ...HEADERS, 'Mcp-Session-Id': sessionId, 'Mcp-Protocol-Version': version };
  await (await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).text();
  return { sessionId, headers };
}

const call = (url: string, headers: Record<string, string>, name: string, args: unknown = {}) =>
  fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } })
  });

describe.skipIf(!REDIS_URL)('sessions in real Redis (Stage 11.2)', () => {
  let stub: WeatherStub;
  const servers: HttpServer[] = [];
  const env = () => ({
    OPEN_METEO_URL: stub.url,
    WEATHER_FETCH_TIMEOUT_MS: '600',
    WEATHER_RETRY_BASE_DELAY_MS: '10',
    SESSION_STORE: 'redis',
    REDIS_URL: REDIS_URL!
  });
  const start = async () => {
    const s = await startHttpServer(env());
    servers.push(s);
    return s;
  };

  beforeAll(async () => {
    stub = await startWeatherStub();
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    await stub.close();
  });

  it('a second instance answers a session it never saw, with its state', async () => {
    const a = await start();
    const b = await start();
    const { sessionId, headers } = await open(a.url);
    await (await call(a.url, headers, 'set_home_location', { name: 'Home', latitude: 1, longitude: 2 })).text();
    // Instance B has no live session for this id, so it rebuilds it from Redis.
    const res = await call(b.url, headers, 'get_home_weather');
    expect(res.status).toBe(200);
    expect((await messageOf(res)).result.content[0].text).toBe('Home: 12.3°C, wind 4.5 km/h');
    expect(b.logs()).toContain(`session ${sessionId} rebuilt from the store`);
  });

  // Stage 11.4, found by the kill test: behind a proxy, one session's requests reach
  // both instances, so each holds a live copy. A copy must pick up a state the other
  // instance saved, or the survivor of a kill answers from an old copy.
  it('an instance that already holds the session picks up state saved by the other', async () => {
    const a = await start();
    const b = await start();
    const { sessionId, headers } = await open(a.url);
    const home = async (url: string) => (await messageOf(await call(url, headers, 'get_home_weather'))).result.content[0].text as string;
    const setHome = async (url: string, name: string) =>
      (await call(url, headers, 'set_home_location', { name, latitude: 1, longitude: 2 })).text();

    await setHome(a.url, 'Dubai');
    expect(await home(b.url)).toMatch(/^Dubai:/); // B rebuilds the session, so it now holds a live copy

    await setHome(b.url, 'Paris'); // B saves a newer state
    expect(await home(a.url)).toMatch(/^Paris:/); // A held an old copy and must refresh it
    expect(a.logs()).toContain(`session ${sessionId} state refreshed from the store`);

    await setHome(a.url, 'Cairo'); // and the other way round
    expect(await home(b.url)).toMatch(/^Cairo:/);
    expect(b.logs()).toContain(`session ${sessionId} state refreshed from the store`);
  });

  it('a restarted server still knows the session and its state', async () => {
    const a = await start();
    const { headers } = await open(a.url);
    await (await call(a.url, headers, 'set_home_location', { name: 'Home', latitude: 1, longitude: 2 })).text();
    await a.stop(); // shutdown closes the live objects but keeps the records
    const b = await start();
    const res = await call(b.url, headers, 'get_home_weather');
    expect(res.status).toBe(200);
    expect((await messageOf(res)).result.content[0].text).toBe('Home: 12.3°C, wind 4.5 km/h');
  });

  it('an id that is not in Redis is still 404', async () => {
    const a = await start();
    const res = await call(a.url, { ...HEADERS, 'Mcp-Session-Id': 'does-not-exist' }, 'add', { a: 1, b: 2 });
    expect(res.status).toBe(404);
  });

  it('DELETE on one instance ends the session for the other too', async () => {
    const a = await start();
    const b = await start();
    const { headers } = await open(a.url);
    expect((await fetch(b.url, { method: 'DELETE', headers })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect((await call(a.url, headers, 'add', { a: 1, b: 2 })).status).toBe(404);
  });
});
