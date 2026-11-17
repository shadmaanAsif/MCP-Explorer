import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  DEFAULT_ALLOWED_ORIGINS,
  createRateLimiter,
  originGuard,
  parseAllowedOrigins,
  rateLimit,
  sizeLimit
} from '../src/http-guards.js';

describe('parseAllowedOrigins', () => {
  it('falls back to the dashboard origins when unset or empty', () => {
    expect(parseAllowedOrigins(undefined)).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(parseAllowedOrigins(' , ')).toEqual(DEFAULT_ALLOWED_ORIGINS);
  });

  it('splits a comma list and normalizes it', () => {
    expect(parseAllowedOrigins('http://A.test/, http://b.test')).toEqual(['http://a.test', 'http://b.test']);
  });
});

describe('originGuard', () => {
  const app = new Hono();
  app.use('*', originGuard(['http://ok.test']));
  app.get('/', (c) => c.text('through'));

  const call = (origin?: string) => app.request('/', { headers: origin ? { Origin: origin } : {} });

  it('passes a missing Origin and a listed one', async () => {
    expect((await call()).status).toBe(200);
    expect((await call('http://ok.test')).status).toBe(200);
  });

  it('refuses anything else with 403', async () => {
    expect((await call('http://evil.test')).status).toBe(403);
    expect((await call('http://ok.test.evil.test')).status).toBe(403);
    expect((await call('null')).status).toBe(403);
  });
});

describe('createRateLimiter (token bucket)', () => {
  it('allows a burst up to the capacity, then refuses', () => {
    const limiter = createRateLimiter(3, () => 0);
    expect(['a', 'a', 'a'].map((k) => limiter.take(k).ok)).toEqual([true, true, true]);
    expect(limiter.take('a').ok).toBe(false);
  });

  it('keeps callers apart', () => {
    const limiter = createRateLimiter(1, () => 0);
    expect(limiter.take('alice').ok).toBe(true);
    expect(limiter.take('alice').ok).toBe(false);
    expect(limiter.take('bob').ok).toBe(true);
  });

  it('refills over time and reports Retry-After', () => {
    let t = 0;
    const limiter = createRateLimiter(60, () => t); // 1 token per second
    for (let i = 0; i < 60; i++) limiter.take('a');
    const refused = limiter.take('a');
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 1 });
    t = 1_000;
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
  });

  it('never holds more than the capacity after a long idle', () => {
    let t = 0;
    const limiter = createRateLimiter(2, () => t);
    limiter.take('a');
    t = 10 * 60_000;
    expect([limiter.take('a').ok, limiter.take('a').ok, limiter.take('a').ok]).toEqual([true, true, false]);
  });
});

describe('rateLimit and sizeLimit middleware', () => {
  it('answers 429 with Retry-After', async () => {
    const app = new Hono();
    app.use('*', rateLimit(1, () => 'k', () => 0));
    app.get('/', (c) => c.text('ok'));
    expect((await app.request('/')).status).toBe(200);
    const res = await app.request('/');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it('answers 413 over the cap and passes a body under it', async () => {
    const app = new Hono();
    app.use('*', sizeLimit(10));
    app.post('/', async (c) => c.text(await c.req.text()));
    const small = await app.request('/', { method: 'POST', body: '12345' });
    expect(small.status).toBe(200);
    const big = await app.request('/', { method: 'POST', body: 'x'.repeat(11) });
    expect(big.status).toBe(413);
  });
});
