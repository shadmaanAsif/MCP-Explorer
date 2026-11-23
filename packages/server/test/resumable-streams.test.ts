// Stage 11.3: a dropped stream resumes with Last-Event-ID, using the real
// compiled server. Memory always; Redis (a second instance replays what the
// first one stored) only when REDIS_URL is set.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { startHttpServer, type HttpServer } from './helpers/http-server.js';
import { startWeatherStub, type WeatherStub } from './helpers/stub-weather.js';

const REDIS_URL = process.env.REDIS_URL;
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

type Sse = { id?: string; data: string };
const parseSse = (text: string): Sse[] =>
  text
    .split('\n\n')
    .map((block) => {
      const id = block.split('\n').find((l) => l.startsWith('id:'))?.slice(3).trim();
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      return { id, data };
    })
    .filter((e) => e.id !== undefined || e.data !== '');

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
  const text = await res.text();
  const version = JSON.parse(parseSse(text).find((e) => e.data)!.data).result.protocolVersion as string;
  const headers = { ...HEADERS, 'Mcp-Session-Id': sessionId, 'Mcp-Protocol-Version': version };
  await (await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).text();
  return { sessionId, headers };
}

const LOCATIONS = [1, 2, 3].map((n) => ({ name: `L${n}`, latitude: n, longitude: n }));

// Runs a 3-location batch with a progress token and returns every SSE event.
async function runBatch(url: string, headers: Record<string, string>): Promise<Sse[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'get_weather_batch', arguments: { locations: LOCATIONS }, _meta: { progressToken: 'p1' } }
    })
  });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  return parseSse(await res.text());
}

// Reconnects the GET stream with Last-Event-ID and reads until `count` messages
// arrived, then drops the connection.
async function resume(
  url: string,
  headers: Record<string, string>,
  lastEventId: string,
  count: number,
  waitMs = 5000
): Promise<Sse[]> {
  const ctl = new AbortController();
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...headers, Accept: 'text/event-stream', 'Last-Event-ID': lastEventId },
    signal: ctl.signal
  });
  if (res.status !== 200) throw Object.assign(new Error(`resume ${res.status}`), { status: res.status, body: await res.text() });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + waitMs;
  // An open stream with nothing to send never ends, so each read has a time limit.
  while (Date.now() < deadline && parseSse(text).filter((e) => e.data).length < count) {
    const next = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now()))]);
    if (next === null || next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  ctl.abort();
  return parseSse(text).filter((e) => e.data);
}

const kind = (e: Sse) => {
  const m = JSON.parse(e.data);
  return m.method === 'notifications/progress' ? `progress ${m.params.progress}` : m.result ? 'result' : 'other';
};

describe('resumable streams', () => {
  let stub: WeatherStub;
  const servers: HttpServer[] = [];
  const env = (extra: Record<string, string> = {}) => ({
    OPEN_METEO_URL: stub.url,
    WEATHER_FETCH_TIMEOUT_MS: '600',
    WEATHER_RETRY_BASE_DELAY_MS: '10',
    RESUMABLE_STREAMS: '1',
    ...extra
  });
  const start = async (extra: Record<string, string> = {}) => {
    const s = await startHttpServer(env(extra));
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

  it('sends event ids, and replays exactly the events after Last-Event-ID', async () => {
    const a = await start();
    const { headers } = await open(a.url);
    const events = await runBatch(a.url, headers);
    // priming (id only), then 3 progress messages and the result, each with an id.
    expect(events.every((e) => e.id)).toBe(true);
    const messages = events.filter((e) => e.data);
    expect(messages.map(kind)).toEqual(['progress 1', 'progress 2', 'progress 3', 'result']);

    // The client saw progress 1, then the connection dropped.
    const replayed = await resume(a.url, headers, messages[0].id!, 3);
    expect(replayed.map(kind)).toEqual(['progress 2', 'progress 3', 'result']);
    expect(replayed.map((e) => e.id)).toEqual(messages.slice(1).map((e) => e.id));
  });

  it('replays nothing new when the client already has the last event', async () => {
    const a = await start();
    const { headers } = await open(a.url);
    const messages = (await runBatch(a.url, headers)).filter((e) => e.data);
    const replayed = await resume(a.url, headers, messages.at(-1)!.id!, 1, 600);
    expect(replayed).toEqual([]);
  });

  it('refuses an event id from another session', async () => {
    const a = await start();
    const one = await open(a.url);
    const two = await open(a.url);
    const messages = (await runBatch(a.url, one.headers)).filter((e) => e.data);
    const err = await resume(a.url, two.headers, messages[0].id!, 1).catch((e) => e);
    expect(err.status).toBe(400);
  });

  it('with resumable streams off (the default) no ids are sent', async () => {
    const a = await start({ RESUMABLE_STREAMS: '0' });
    const { headers } = await open(a.url);
    const events = await runBatch(a.url, headers);
    expect(events.some((e) => e.id)).toBe(false);
  });

  it.skipIf(!REDIS_URL)('a second instance replays events the first one stored (Redis)', async () => {
    const shared = { SESSION_STORE: 'redis', REDIS_URL: REDIS_URL! };
    const a = await start(shared);
    const b = await start(shared);
    const { headers } = await open(a.url);
    const messages = (await runBatch(a.url, headers)).filter((e) => e.data);
    const replayed = await resume(b.url, headers, messages[0].id!, 3);
    expect(replayed.map(kind)).toEqual(['progress 2', 'progress 3', 'result']);
  });
});
