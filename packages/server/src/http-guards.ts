// Stage 10.2: the MCP spec says an HTTP server MUST validate the Origin header,
// so a web page in the user's browser cannot talk to a local server through
// DNS rebinding. Browsers always send Origin on cross-site requests; curl, the
// CLI client and Cursor send none, so a missing Origin is allowed.
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

// The dashboard's own origins. Anything else (the Inspector, your own web app)
// is added through ALLOWED_ORIGINS.
export const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:4767', 'http://127.0.0.1:4767'];

function normalize(origin: string): string {
  return origin.trim().replace(/\/+$/, '').toLowerCase();
}

/** ALLOWED_ORIGINS is a comma-separated list. Empty or unset means the defaults. */
export function parseAllowedOrigins(value: string | undefined): string[] {
  const list = (value ?? '')
    .split(',')
    .map(normalize)
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ALLOWED_ORIGINS;
}

export function originGuard(allowed: string[]): MiddlewareHandler {
  const set = new Set(allowed.map(normalize));
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin === undefined || set.has(normalize(origin))) {
      await next();
      return;
    }
    // Also covers the literal "null" a sandboxed page sends: it is not in the list.
    return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Origin not allowed' }, id: null }, 403);
  };
}

// ---- Stage 10.3: size and rate limits ------------------------------------

export const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MB
export const DEFAULT_RATE_PER_MINUTE = 120;

type Bucket = { tokens: number; updated: number };

/**
 * A token bucket per key: it holds up to `perMinute` tokens, refills at
 * perMinute/60s, and each request takes one. A burst up to the capacity is
 * fine; a steady rate above perMinute is refused. In memory, so the limit is
 * per server instance (Stage 11 revisits that).
 */
export function createRateLimiter(perMinute: number, now: () => number = Date.now) {
  const buckets = new Map<string, Bucket>();
  const refillPerMs = perMinute / 60_000;

  function take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const t = now();
    const bucket = buckets.get(key) ?? { tokens: perMinute, updated: t };
    bucket.tokens = Math.min(perMinute, bucket.tokens + (t - bucket.updated) * refillPerMs);
    bucket.updated = t;
    // Keeps the map from growing without bound: a full bucket is the same as no bucket.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) if (b.tokens >= perMinute) buckets.delete(k);
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      buckets.set(key, bucket);
      return { ok: true };
    }
    buckets.set(key, bucket);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)) };
  }

  return { take, size: () => buckets.size };
}

/** 429 with Retry-After once a caller passes their rate. `keyOf` picks who the caller is. */
export function rateLimit(
  perMinute: number,
  keyOf: (c: Context) => string,
  now?: () => number
): MiddlewareHandler {
  const limiter = createRateLimiter(perMinute, now);
  return async (c, next) => {
    const result = limiter.take(keyOf(c));
    if (result.ok) {
      await next();
      return;
    }
    c.header('Retry-After', String(result.retryAfterSeconds));
    return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit exceeded' }, id: null }, 429);
  };
}

/** 413 for a body over `maxBytes`. Hono checks Content-Length and also counts chunked bodies. */
export function sizeLimit(maxBytes: number): MiddlewareHandler {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) =>
      c.json({ jsonrpc: '2.0', error: { code: -32000, message: `Request body over ${maxBytes} bytes` }, id: null }, 413)
  });
}
