// Stage 12.2: /healthz and /readyz on their own listener. The first group tests the
// Hono app directly (no port, no process), the second the real compiled server, and
// the third takes real Redis away and brings it back (skipped unless REDIS_URL is set).
import { createServer } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminApp, type ReadinessCheck } from '../src/admin.js';
import { freePort, startHttpServer, type HttpServer } from './helpers/http-server.js';
import { startTcpForwarder } from './helpers/tcp-forwarder.js';

const REDIS_URL = process.env.REDIS_URL;

// startHttpServer returns once the MCP port is up. The admin listener reports a moment
// later, so a probe sent right away can find its port still closed under load.
const adminListening = (server: HttpServer) =>
  vi.waitFor(() => expect(server.logs()).toContain('admin endpoints on'), { timeout: 5000 });

describe('the admin app (Stage 12.2)', () => {
  let logged: string[];
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'error').mockImplementation((line) => {
      logged.push(String(line));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const app = (checks: ReadinessCheck[], extra: Partial<Parameters<typeof createAdminApp>[0]> = {}) =>
    createAdminApp({ isShuttingDown: () => false, checks, cacheMs: 0, ...extra });
  const store = (run: ReadinessCheck['run']): ReadinessCheck => ({ name: 'session store', run });

  it('says /healthz is ok, even when a check fails and while shutting down', async () => {
    const a = app([store(async () => Promise.reject(new Error('down')))], { isShuttingDown: () => true });
    const res = await a.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('says /readyz is ready when there is nothing to check (memory store)', async () => {
    const res = await app([]).request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503 "shutting down" at once, without running any check', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const res = await app([store(run)], { isShuttingDown: () => true }).request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'not ready', reason: 'shutting down' });
    expect(run).not.toHaveBeenCalled();
  });

  it('answers 503 naming the check when it fails, and 200 again after it recovers', async () => {
    let failing = true;
    const a = app([
      store(async () => {
        if (failing) throw new Error('down');
      })
    ]);
    const down = await a.request('/readyz');
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ status: 'not ready', reason: 'session store unavailable' });
    failing = false;
    expect((await a.request('/readyz')).status).toBe(200);
  });

  it('counts a check that takes too long as failed', async () => {
    const a = app([store(() => new Promise(() => {}))], { timeoutMs: 30 });
    const res = await a.request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'not ready', reason: 'session store unavailable' });
  });

  it('never puts the error text in the answer or the log (it can hold the Redis URL)', async () => {
    const a = app([store(async () => Promise.reject(new Error('connect ECONNREFUSED redis://:s3cret@db:6379')))]);
    const res = await a.request('/readyz');
    expect(await res.text()).not.toContain('s3cret');
    expect(logged.join('\n')).not.toContain('s3cret');
  });

  it('reuses a result for cacheMs, then asks again', async () => {
    let t = 0;
    const run = vi.fn().mockResolvedValue(undefined);
    const a = app([store(run)], { cacheMs: 2000, now: () => t });
    await a.request('/readyz');
    t = 1999;
    await a.request('/readyz');
    expect(run).toHaveBeenCalledTimes(1);
    t = 2000;
    await a.request('/readyz');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('lets probes that arrive together share one check', async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const a = app([store(run)], { cacheMs: 2000 });
    const first = a.request('/readyz');
    const second = a.request('/readyz');
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    finish();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('logs only a change of state, not every probe', async () => {
    let failing = true;
    const a = app([
      store(async () => {
        if (failing) throw new Error('down');
      })
    ]);
    for (let i = 0; i < 3; i++) await a.request('/readyz');
    failing = false;
    for (let i = 0; i < 3; i++) await a.request('/readyz');
    const lines = logged.filter((l) => l.includes('readiness:'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('readiness: not ready (session store unavailable)');
    expect(lines[1]).toContain('readiness: ready again');
  });

  it('answers 404 for anything else, including a POST to /healthz', async () => {
    const a = app([]);
    expect((await a.request('/nope')).status).toBe(404);
    expect((await a.request('/healthz', { method: 'POST' })).status).toBe(404);
  });
});

describe('the admin listener in the real server (Stage 12.2)', () => {
  const servers: HttpServer[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.stop()));
  });
  const start = async (env: Record<string, string>) => {
    const s = await startHttpServer({ SESSION_STORE: 'memory', ...env });
    servers.push(s);
    return s;
  };

  it('serves /healthz and /readyz on ADMIN_PORT, and neither on the MCP port', async () => {
    const adminPort = await freePort();
    const server = await start({ ADMIN_PORT: String(adminPort) });
    await adminListening(server);
    const admin = `http://127.0.0.1:${adminPort}`;

    const health = await fetch(`${admin}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${admin}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
    // Probes are not requests to the MCP app, so they are not in its request log.
    expect(server.logs()).not.toMatch(/GET \/healthz 200/);
    expect(server.logs()).toContain(`admin endpoints on http://127.0.0.1:${adminPort}`);

    const mcpOrigin = new URL(server.url).origin;
    expect((await fetch(`${mcpOrigin}/healthz`)).status).toBe(404);
    expect((await fetch(`${mcpOrigin}/readyz`)).status).toBe(404);
  });

  it('starts no admin listener when ADMIN_PORT is not set', async () => {
    const server = await start({});
    expect(server.logs()).not.toContain('admin endpoints');
  });

  it('stops with a clear line when the admin port is already in use', async () => {
    const busy = createServer();
    const port = await new Promise<number>((resolve) => busy.listen(0, '127.0.0.1', () => resolve((busy.address() as { port: number }).port)));
    try {
      // The server may print "running on" just before the listener error, so look at the output either way.
      const outcome = await startHttpServer({ SESSION_STORE: 'memory', ADMIN_PORT: String(port) }).then(
        (s) => {
          servers.push(s);
          return s.logs;
        },
        (error: Error) => () => error.message
      );
      await vi.waitFor(() => expect(outcome()).toContain('Cannot start the admin listener'), { timeout: 5000 });
      expect(outcome()).toContain('EADDRINUSE');
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  });
});

describe.skipIf(!REDIS_URL)('readiness with real Redis (Stage 12.2)', () => {
  const servers: HttpServer[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.stop()));
  });

  it('is 503 while Redis is away, with /healthz still 200, and 200 again when it is back', async () => {
    const redis = new URL(REDIS_URL!);
    const forwarder = await startTcpForwarder({ host: redis.hostname, port: Number(redis.port || 6379) });
    try {
      const adminPort = await freePort();
      const server = await startHttpServer({
        SESSION_STORE: 'redis',
        REDIS_URL: `redis://127.0.0.1:${forwarder.port}`,
        ADMIN_PORT: String(adminPort)
      });
      servers.push(server);
      await adminListening(server);
      // A refused probe means the server is gone: show what it printed before it went.
      const probe = async (path: string) => {
        try {
          return await fetch(`http://127.0.0.1:${adminPort}${path}`);
        } catch (error) {
          throw new Error(`probe ${path} failed (${error}); server output:\n${server.logs()}`);
        }
      };

      expect((await probe('/readyz')).status).toBe(200);

      await forwarder.down();
      await vi.waitFor(async () => expect((await probe('/readyz')).status).toBe(503), { timeout: 10_000, interval: 200 });
      expect(await (await probe('/readyz')).json()).toEqual({ status: 'not ready', reason: 'session store unavailable' });
      expect((await probe('/healthz')).status).toBe(200);

      await forwarder.up();
      await vi.waitFor(async () => expect((await probe('/readyz')).status).toBe(200), { timeout: 20_000, interval: 250 });

      const logs = server.logs();
      expect(logs).toContain('readiness: not ready (session store unavailable)');
      expect(logs).toContain('readiness: ready again');
      expect(logs).not.toContain(`127.0.0.1:${forwarder.port}`);
    } finally {
      await forwarder.close();
    }
  }, 45_000);
});
