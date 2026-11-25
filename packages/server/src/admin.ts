// Stage 12.2: a second, small listener for the people and tools that look after
// the server (health probes now, metrics in 12.3), kept off the MCP port on
// purpose (decision D6). The MCP port carries the Origin, auth and rate-limit
// guards and sits behind the proxy; nothing here should be reachable that way by
// accident, and a probe should not need a token.
//
//   GET /healthz   "restart me?"          200 as long as the process answers
//   GET /readyz    "send me traffic?"     200, or 503 with a short reason
//
// Two endpoints because the questions differ. If liveness checked Redis, a Redis
// outage would make the orchestrator restart every healthy server, which fixes
// nothing. So /healthz never looks at Redis, and it stays 200 while the server
// drains on shutdown: failing it then would get the process killed mid-drain.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { log } from './log.js';

/** One thing readiness depends on. `run` rejects when it is not available. */
export type ReadinessCheck = { name: string; run: () => Promise<unknown> };

export type AdminOptions = {
  /** True once shutdown has begun: /readyz answers 503 at once (12.5 drains after this). */
  isShuttingDown: () => boolean;
  /** Empty when nothing external is needed, as with the memory session store. */
  checks: ReadinessCheck[];
  /** A check that takes longer counts as failed. Default 1000. */
  timeoutMs?: number;
  /** How long a result is reused, so a probe storm cannot hammer Redis. Default 2000. */
  cacheMs?: number;
  now?: () => number;
};

type Readiness = { ok: true } | { ok: false; reason: string };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createAdminApp(options: AdminOptions): Hono {
  const { isShuttingDown, checks } = options;
  const timeoutMs = options.timeoutMs ?? 1000;
  const cacheMs = options.cacheMs ?? 2000;
  const now = options.now ?? Date.now;

  let cached: { at: number; result: Readiness } | undefined;
  let inflight: Promise<Readiness> | undefined;
  let lastOk = true; // ready until a probe says otherwise

  // Only a change is logged: a probe every few seconds must not fill the log.
  const noteResult = (result: Readiness) => {
    if (result.ok !== lastOk) {
      if (result.ok) log.info('readiness: ready again');
      else log.warn(`readiness: not ready (${result.reason})`);
    }
    lastOk = result.ok;
  };

  async function runChecks(): Promise<Readiness> {
    for (const check of checks) {
      try {
        await withTimeout(check.run(), timeoutMs);
      } catch {
        // Name the check, never the error: a Redis error can hold the connection URL.
        return { ok: false, reason: `${check.name} unavailable` };
      }
    }
    return { ok: true };
  }

  // Probes that arrive together share one run; later ones reuse the result for cacheMs.
  function readiness(): Promise<Readiness> {
    if (cached && now() - cached.at < cacheMs) return Promise.resolve(cached.result);
    inflight ??= runChecks()
      .then((result) => {
        cached = { at: now(), result };
        noteResult(result);
        return result;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  const app = new Hono();
  // A probe answer must never come from a cache between the probe and us.
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/readyz', async (c) => {
    if (isShuttingDown()) return c.json({ status: 'not ready', reason: 'shutting down' }, 503);
    const result = await readiness();
    return result.ok ? c.json({ status: 'ready' }) : c.json({ status: 'not ready', reason: result.reason }, 503);
  });

  app.notFound((c) => c.body(null, 404));
  app.onError((error, c) => {
    log.error('admin request failed:', { err: error });
    return c.body(null, 500);
  });
  return app;
}

/**
 * Listens on host:port. If the port is taken it stops the process with a clear
 * line instead of an unhandled error: a server that silently has no health
 * endpoint would look ready to nobody.
 */
export function startAdminServer(app: Hono, { port, host }: { port: number; host: string }) {
  const where = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  const server = serve({ fetch: app.fetch, port, hostname: host }, () => {
    log.info(`admin endpoints on http://${where} (/healthz, /readyz)`);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    log.error(`Cannot start the admin listener on ${where} (${error.code ?? 'error'}). Check ADMIN_PORT and ADMIN_HOST.`, {
      bare: true
    });
    process.exit(1);
  });
  return server;
}
