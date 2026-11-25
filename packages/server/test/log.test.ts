// Stage 12.1: the logger, and the proof that its request context survives the
// SDK. The unit tests need no server. The rest start the real compiled server
// (build/http.js) and read what it writes to stderr: the context has to reach a
// tool handler, a stream replay and a rebuilt session, and none of those get
// the HTTP request passed in, so only a real run can show it works.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createKeys, createToken, issuerApp } from '../src/auth/issuer.js';
import {
  createLogger,
  logSettingsFromEnv,
  newRequestId,
  runWithContext,
  setContext,
  type LogSettings
} from '../src/log.js';
import { startHttpServer, type HttpServer } from './helpers/http-server.js';
import { startWeatherStub, type WeatherStub } from './helpers/stub-weather.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the logger itself --------------------------------------------------

function capture(settings: Partial<LogSettings> = {}) {
  const lines: string[] = [];
  const logger = createLogger({ instance: 'inst-1', ...settings }, (line) => lines.push(line));
  return { logger, lines };
}

describe('logger: text format (the default)', () => {
  it('prints today\'s line plus the instance when there is no request', () => {
    const { logger, lines } = capture();
    logger.info('session abc opened (1 active)');
    expect(lines).toEqual(['[mcp-demo] session abc opened (1 active) instance=inst-1']);
  });

  it('adds req, session and sub from the request context, in a fixed order', () => {
    const { logger, lines } = capture();
    runWithContext({ req: 'r1', session: 's1', sub: 'alice' }, () => logger.info('hello'));
    expect(lines).toEqual(['[mcp-demo] hello req=r1 session=s1 sub=alice instance=inst-1']);
  });

  it('quotes a value that has spaces, so key=value stays parseable', () => {
    const { logger, lines } = capture();
    logger.info('hello', { note: 'two words' });
    expect(lines).toEqual(['[mcp-demo] hello note="two words" instance=inst-1']);
  });

  it('leaves out the prefix for a bare line, and never prints the flag', () => {
    const { logger, lines } = capture();
    logger.info('mcp-demo server running on http://localhost:1/mcp (stateful)', { bare: true });
    expect(lines).toEqual(['mcp-demo server running on http://localhost:1/mcp (stateful) instance=inst-1']);
  });

  it('prints an error\'s stack after the message', () => {
    const { logger, lines } = capture();
    logger.error('error handling request:', { err: new Error('boom') });
    expect(lines[0]).toMatch(/^\[mcp-demo\] error handling request: Error: boom\n\s+at /);
  });
});

describe('logger: json format', () => {
  it('prints one object per line with a fixed key order and the msg last', () => {
    const { logger, lines } = capture({ format: 'json' });
    runWithContext({ req: 'r1', session: 's1' }, () => logger.info('session s1 opened (1 active)'));
    const line = JSON.parse(lines[0]);
    expect(Object.keys(line)).toEqual(['time', 'level', 'instance', 'req', 'session', 'msg']);
    expect(line).toMatchObject({ level: 'info', instance: 'inst-1', req: 'r1', session: 's1', msg: 'session s1 opened (1 active)' });
    expect(new Date(line.time).toISOString()).toBe(line.time);
  });

  it('keeps the message text unchanged and puts the facts in fields', () => {
    const { logger, lines } = capture({ format: 'json' });
    logger.info('mcp-demo server running on stdio', { bare: true });
    const line = JSON.parse(lines[0]);
    expect(line.msg).toBe('mcp-demo server running on stdio');
    expect('bare' in line).toBe(false);
    expect('req' in line).toBe(false);
  });

  it('puts an error in err and stack', () => {
    const { logger, lines } = capture({ format: 'json' });
    logger.error('x:', { err: new Error('boom') });
    const line = JSON.parse(lines[0]);
    expect(line.err).toBe('boom');
    expect(line.stack).toContain('Error: boom');
    logger.error('y:', { err: 'plain' });
    expect(JSON.parse(lines[1]).err).toBe('plain');
  });
});

describe('logger: levels and settings', () => {
  it('hides debug at the default level, shows it at debug', () => {
    const { logger, lines } = capture();
    logger.debug('d');
    expect(lines).toEqual([]);
    logger.configure({ level: 'debug' });
    logger.debug('d');
    expect(lines).toHaveLength(1);
  });

  it('warn hides info and debug but keeps warn and error', () => {
    const { logger, lines } = capture({ level: 'warn', format: 'json' });
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['c', 'd']);
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error']);
  });

  it('configure ignores a setting that was not given', () => {
    const { logger } = capture({ level: 'warn' });
    logger.configure({ format: 'json', instance: undefined });
    expect(logger.settings()).toEqual({ format: 'json', level: 'warn', instance: 'inst-1' });
  });

  it('reads the stdio settings from the environment and ignores bad values', () => {
    expect(logSettingsFromEnv({ LOG_FORMAT: 'json', LOG_LEVEL: 'debug', INSTANCE_ID: 'x' })).toEqual({
      format: 'json',
      level: 'debug',
      instance: 'x'
    });
    expect(logSettingsFromEnv({ LOG_FORMAT: 'yaml', LOG_LEVEL: 'loud' })).toEqual({});
  });
});

describe('request context', () => {
  it('survives awaits, timers and parallel branches', async () => {
    const { logger, lines } = capture({ format: 'json' });
    await runWithContext({ req: 'A' }, async () => {
      await sleep(5);
      logger.info('after a timer');
      await Promise.all([
        (async () => {
          await sleep(1);
          logger.info('in a branch');
        })()
      ]);
    });
    expect(lines.map((l) => JSON.parse(l).req)).toEqual(['A', 'A']);
  });

  it('keeps two requests that overlap apart', async () => {
    const { logger, lines } = capture({ format: 'json' });
    const run = (req: string, delay: number) =>
      runWithContext({ req }, async () => {
        await sleep(delay);
        logger.info(`line from ${req}`);
        await sleep(delay);
        logger.info(`again from ${req}`);
      });
    await Promise.all([run('one', 3), run('two', 2)]);
    for (const line of lines.map((l) => JSON.parse(l))) {
      expect(line.msg.endsWith(line.req)).toBe(true);
    }
  });

  it('setContext adds facts for the lines that come after, and an explicit field wins', () => {
    const { logger, lines } = capture({ format: 'json' });
    runWithContext({ req: 'r' }, () => {
      logger.info('before');
      setContext({ session: 's-header', sub: undefined });
      logger.info('after');
      logger.info('explicit', { session: 's-explicit' });
    });
    const parsed = lines.map((l) => JSON.parse(l));
    expect('session' in parsed[0]).toBe(false);
    expect(parsed[1].session).toBe('s-header');
    expect('sub' in parsed[1]).toBe(false);
    expect(parsed[2].session).toBe('s-explicit');
  });

  it('is a no-op outside a request: nothing thrown, no req on the line', () => {
    const { logger, lines } = capture({ format: 'json' });
    setContext({ session: 'x' });
    logger.info('outside');
    expect('req' in JSON.parse(lines[0])).toBe(false);
    expect('session' in JSON.parse(lines[0])).toBe(false);
  });

  it('makes short, different ids', () => {
    const ids = new Set(Array.from({ length: 50 }, newRequestId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ---- in a real server ---------------------------------------------------

const REDIS_URL = process.env.REDIS_URL;
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const LOCATIONS = [1, 2, 3].map((n) => ({ name: `L${n}`, latitude: n, longitude: n }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Line = Record<string, any>;

// Only whole lines: the last chunk may be half written.
function jsonLines(logs: string): Line[] {
  const parts = logs.split('\n');
  if (!logs.endsWith('\n')) parts.pop();
  return parts.filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function waitFor<T>(find: () => T | undefined, what: string, server: HttpServer, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = find();
    if (found !== undefined) return found;
    await sleep(20);
  }
  throw new Error(`never saw ${what}. Server output:\n${server.logs()}`);
}
const waitForLine = (server: HttpServer, test: (l: Line) => boolean, what: string) =>
  waitFor(() => jsonLines(server.logs()).find(test), what, server);
const waitForText = (server: HttpServer, pattern: RegExp) =>
  waitFor(() => (pattern.test(server.logs()) ? true : undefined), String(pattern), server);

async function rpc(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function openSession(url: string, extra: Record<string, string> = {}) {
  const res = await rpc(url, { ...HEADERS, ...extra }, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw', version: '0' } }
  });
  const sessionId = res.headers.get('mcp-session-id')!;
  await res.text();
  const headers = { ...HEADERS, ...extra, 'Mcp-Session-Id': sessionId, 'Mcp-Protocol-Version': LATEST_PROTOCOL_VERSION };
  await (await rpc(url, headers, { jsonrpc: '2.0', method: 'notifications/initialized' })).text();
  return { sessionId, headers };
}

const callAdd = (url: string, headers: Record<string, string>) =>
  rpc(url, headers, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add', arguments: { a: 2, b: 3 } } });

const parseSse = (text: string) =>
  text
    .split('\n\n')
    .map((block) => ({
      id: block.split('\n').find((l) => l.startsWith('id:'))?.slice(3).trim(),
      data: block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
    }))
    .filter((e) => e.id !== undefined || e.data !== '');

describe('request context in a real server (does it survive the SDK?)', () => {
  let stub: WeatherStub;
  const servers: HttpServer[] = [];
  const start = async (env: Record<string, string> = {}) => {
    const s = await startHttpServer({
      OPEN_METEO_URL: stub.url,
      WEATHER_FETCH_TIMEOUT_MS: '600',
      WEATHER_RETRY_BASE_DELAY_MS: '10',
      ...env
    });
    servers.push(s);
    return s;
  };
  const JSON_DEBUG = { LOG_FORMAT: 'json', LOG_LEVEL: 'debug' };

  beforeAll(async () => {
    stub = await startWeatherStub();
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    await stub.close();
  });

  it('a tool\'s own line has the call\'s session and the same req as the request line and the audit line', async () => {
    const s = await start(JSON_DEBUG);
    const { sessionId, headers } = await openSession(s.url);
    await (await callAdd(s.url, headers)).text();

    const tool = await waitForLine(s, (l) => l.msg === 'add called with a=2, b=3', 'the add line');
    expect(tool).toMatchObject({ level: 'debug', session: sessionId });
    expect(tool.req).toMatch(/^[0-9a-f]{8}$/);
    expect('sub' in tool).toBe(false); // auth is off

    const request = await waitForLine(s, (l) => l.req === tool.req && /^POST \/mcp 200 \d+ms$/.test(l.msg), 'its request line');
    expect(request.session).toBe(sessionId);
    const audit = await waitForLine(s, (l) => l.type === 'audit' && l.req === tool.req, 'its audit line');
    expect(audit).toMatchObject({ tool: 'add', session: sessionId });
  });

  it('the line for a new session, and the request that opened it, carry the new id', async () => {
    const s = await start(JSON_DEBUG);
    const { sessionId } = await openSession(s.url);
    const opened = await waitForLine(s, (l) => l.msg?.startsWith(`session ${sessionId} opened`), 'the opened line');
    expect(opened.session).toBe(sessionId);
    // The id exists only after the SDK handled initialize; the request line still has it.
    const request = await waitForLine(s, (l) => l.req === opened.req && /^POST \/mcp 200 /.test(l.msg), 'the request line');
    expect(request.session).toBe(sessionId);
  });

  it('a stream\'s events and its replay carry the session, and each belongs to its own request', async () => {
    const s = await start({ ...JSON_DEBUG, LOG_LEVEL: 'info', RESUMABLE_STREAMS: '1', EVENT_STORE_DEBUG: '1' });
    const { sessionId, headers } = await openSession(s.url);
    const batch = await rpc(s.url, headers, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'get_weather_batch', arguments: { locations: LOCATIONS }, _meta: { progressToken: 'p1' } }
    });
    const events = parseSse(await batch.text()).filter((e) => e.data);
    expect(events.length).toBeGreaterThanOrEqual(4);

    // Saved inside the POST that ran the tool: same req as that POST's request line.
    const stored = await waitForLine(s, (l) => l.msg?.startsWith('event stored') && l.msg.includes('(progress 1/3)'), 'a stored progress event');
    expect(stored.session).toBe(sessionId);
    // Same stream as that progress event (the initialize reply is a "(result)" too, on another stream).
    const stream = /^event stored (\S+)~\d+ /.exec(stored.msg)![1];
    const resultStored = await waitForLine(
      s,
      (l) => l.msg?.startsWith(`event stored ${stream}~`) && l.msg.includes('(result)'),
      'the stored result of the same stream'
    );
    expect(resultStored.req).toBe(stored.req);
    const post = await waitForLine(s, (l) => l.req === stored.req && /^POST \/mcp 200 /.test(l.msg), 'the batch request line');
    expect(post.session).toBe(sessionId);

    // The reconnect is a different request: the long-lived GET stream.
    const ctl = new AbortController();
    const resume = await fetch(s.url, {
      method: 'GET',
      headers: { ...headers, Accept: 'text/event-stream', 'Last-Event-ID': events[0].id! },
      signal: ctl.signal
    });
    try {
      expect(resume.status).toBe(200);
      const requested = await waitForLine(s, (l) => l.msg?.startsWith('replay requested after'), 'the replay line');
      expect(requested.session).toBe(sessionId);
      expect(requested.req).not.toBe(stored.req);
      const get = await waitForLine(s, (l) => l.req === requested.req && /^GET \/mcp 200 /.test(l.msg), 'the GET request line');
      expect(get.session).toBe(sessionId);
    } finally {
      ctl.abort();
    }
  });

  it.skipIf(!REDIS_URL)('a session rebuilt on another instance has its context from the first line on (Redis)', async () => {
    const shared = { ...JSON_DEBUG, SESSION_STORE: 'redis', REDIS_URL: REDIS_URL!, INSTANCE_ID: 'a' };
    const a = await start(shared);
    const b = await start({ ...shared, INSTANCE_ID: 'b' });
    const { sessionId, headers } = await openSession(a.url);
    await (await callAdd(b.url, headers)).text();

    const rebuilt = await waitForLine(b, (l) => l.msg?.startsWith(`session ${sessionId} rebuilt from the store`), 'the rebuilt line');
    expect(rebuilt).toMatchObject({ session: sessionId, instance: 'b' });
    const tool = await waitForLine(b, (l) => l.msg === 'add called with a=2, b=3', 'the add line on b');
    expect(tool).toMatchObject({ session: sessionId, req: rebuilt.req, instance: 'b' });
    const request = await waitForLine(b, (l) => l.req === rebuilt.req && /^POST \/mcp 200 /.test(l.msg), 'the request line on b');
    expect(request.session).toBe(sessionId);
  });

  it('in json mode every line is json, including the start-up line, and INSTANCE_ID names the instance', async () => {
    const s = await start({ LOG_FORMAT: 'json', INSTANCE_ID: 'server-a' });
    const { headers } = await openSession(s.url);
    await (await callAdd(s.url, headers)).text();
    await waitForLine(s, (l) => /^POST \/mcp 200 /.test(l.msg ?? '') && l.session !== undefined, 'a request line');
    const lines = jsonLines(s.logs()); // throws on a line that is not json
    const banner = lines.find((l) => l.msg?.startsWith('mcp-demo server running on'));
    expect(banner).toMatchObject({ level: 'info', instance: 'server-a' });
    for (const line of lines.filter((l) => l.type !== 'audit')) expect(line.instance).toBe('server-a');
  });

  it('in text mode (the default) a line is today\'s text plus req, session and instance', async () => {
    const s = await start();
    const { sessionId, headers } = await openSession(s.url);
    await (await callAdd(s.url, headers)).text();
    await waitForText(s, new RegExp(`\\[mcp-demo\\] POST /mcp 200 \\d+ms req=[0-9a-f]{8} session=${sessionId} instance=\\S+`));
    await waitForText(s, new RegExp(`\\[mcp-demo\\] session ${sessionId} opened \\(1 active\\) req=[0-9a-f]{8} session=${sessionId}`));
  });

  it('a tool\'s argument line is not printed at info, and comes back at debug', async () => {
    const quiet = await start();
    const loud = await start({ LOG_LEVEL: 'debug' });
    for (const s of [quiet, loud]) {
      const { headers } = await openSession(s.url);
      await (await callAdd(s.url, headers)).text();
    }
    await waitForText(loud, /add called with a=2, b=3/);
    await waitForText(quiet, /POST \/mcp 200/); // the add call has finished and been logged
    expect(quiet.logs()).not.toContain('add called with');
    expect(loud.logs()).toMatch(/\[mcp-demo\] add called with a=2, b=3 req=[0-9a-f]{8} session=\S+ instance=\S+/);
  });

  it('with auth on, lines name the caller (sub) and never contain the token', async () => {
    const keys = await createKeys();
    const app = issuerApp(keys);
    const issuer = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const i = serve({ fetch: (r) => app.fetch(r), port: 0, hostname: '127.0.0.1' }, () => resolve(i));
    });
    const issuerUrl = `http://127.0.0.1:${(issuer as unknown as { address(): { port: number } }).address().port}`;
    const s = await start({ ...JSON_DEBUG, AUTH_REQUIRED: '1', ISSUER_URL: issuerUrl, MCP_SERVER_URL: '' });
    try {
      const audience = s.url.replace('127.0.0.1', 'localhost');
      const token = await createToken(keys, { issuer: issuerUrl, subject: 'alice', audience, scope: 'mcp:tools weather:use' });
      const { sessionId, headers } = await openSession(s.url, { Authorization: `Bearer ${token}` });
      await (await callAdd(s.url, headers)).text();

      const tool = await waitForLine(s, (l) => l.msg === 'add called with a=2, b=3', 'the add line');
      expect(tool).toMatchObject({ session: sessionId, sub: 'alice' });
      const request = await waitForLine(s, (l) => l.req === tool.req && /^POST \/mcp 200 /.test(l.msg), 'its request line');
      expect(request.sub).toBe('alice');

      // A request with no token is refused, and its line has no caller.
      const refused = await fetch(s.url, { method: 'POST', headers: HEADERS, body: '{}' });
      expect(refused.status).toBe(401);
      const refusedLine = await waitForLine(s, (l) => /^POST \/mcp 401 /.test(l.msg ?? ''), 'the 401 line');
      expect('sub' in refusedLine).toBe(false);

      expect(s.logs()).not.toContain(token);
    } finally {
      issuer.close();
    }
  });
});
