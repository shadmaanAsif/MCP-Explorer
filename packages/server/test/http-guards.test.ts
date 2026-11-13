import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_ALLOWED_ORIGINS, originGuard, parseAllowedOrigins } from '../src/http-guards.js';

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
