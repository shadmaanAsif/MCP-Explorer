import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWeather } from '../src/create-server.js';
import { startWeatherStub, type WeatherStub } from './helpers/stub-weather.js';

// Short timeout and backoff so the retry paths take milliseconds, not 25s.
// fetchWeather reads these when a call starts, so setting them here is enough.
let stub: WeatherStub;
const never = new AbortController().signal;

beforeAll(async () => {
  stub = await startWeatherStub();
  process.env.OPEN_METEO_URL = stub.url;
  process.env.WEATHER_FETCH_TIMEOUT_MS = '300';
  process.env.WEATHER_RETRY_BASE_DELAY_MS = '10';
  vi.spyOn(console, 'error').mockImplementation(() => {}); // silence retry logs
});

afterAll(async () => {
  vi.restoreAllMocks();
  delete process.env.OPEN_METEO_URL;
  delete process.env.WEATHER_FETCH_TIMEOUT_MS;
  delete process.env.WEATHER_RETRY_BASE_DELAY_MS;
  await stub.close();
});

beforeEach(() => {
  stub.mode = 'ok';
  stub.hits = 0;
  stub.closed = 0;
});

describe('fetchWeather', () => {
  it('returns formatted weather on success, with one upstream call', async () => {
    const result = await fetchWeather(25.2, 55.27, never);
    expect(result).toEqual({ ok: true, text: '12.3°C, wind 4.5 km/h' });
    expect(stub.hits).toBe(1);
  });

  it('does not retry a 4xx', async () => {
    stub.mode = '404';
    const result = await fetchWeather(0, 0, never);
    expect(result).toEqual({ ok: false, message: 'Open-Meteo returned 404 Not Found' });
    expect(stub.hits).toBe(1);
  });

  it('does not retry a body that is not JSON', async () => {
    stub.mode = 'badjson';
    const result = await fetchWeather(0, 0, never);
    expect(result).toEqual({ ok: false, message: 'Open-Meteo returned a response that was not valid JSON' });
    expect(stub.hits).toBe(1);
  });

  it('does not retry a JSON body with the wrong shape', async () => {
    stub.mode = 'badshape';
    const result = await fetchWeather(0, 0, never);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('unexpected response shape');
    expect(stub.hits).toBe(1);
  });

  it('retries a 5xx and gives up after 3 attempts', async () => {
    stub.mode = '500';
    const result = await fetchWeather(0, 0, never);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('500');
    expect(!result.ok && result.message).toContain('gave up after 3 attempts');
    expect(stub.hits).toBe(3);
  });

  it('times out a hung upstream and retries', async () => {
    stub.mode = 'hang';
    const result = await fetchWeather(0, 0, never);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('did not respond within 0.3s');
    expect(!result.ok && result.message).toContain('gave up after 3 attempts');
    expect(stub.hits).toBe(3);
  });

  it('recovers when a 5xx clears before the last attempt', async () => {
    stub.mode = '500';
    const pending = fetchWeather(0, 0, never);
    setTimeout(() => (stub.mode = 'ok'), 5);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(stub.hits).toBeGreaterThanOrEqual(2);
  });

  it('reports an unreachable upstream', async () => {
    const saved = process.env.OPEN_METEO_URL;
    process.env.OPEN_METEO_URL = 'http://127.0.0.1:1'; // nothing listens on port 1
    try {
      const result = await fetchWeather(0, 0, never);
      expect(!result.ok && result.message).toContain('Failed to reach Open-Meteo');
      expect(!result.ok && result.message).toContain('gave up after 3 attempts');
    } finally {
      process.env.OPEN_METEO_URL = saved;
    }
  });

  it('stops at once when the caller cancels mid-request, with no retry', async () => {
    process.env.WEATHER_FETCH_TIMEOUT_MS = '5000'; // so only the cancel can end it
    try {
      stub.mode = 'hang';
      const controller = new AbortController();
      const pending = fetchWeather(0, 0, controller.signal);
      await vi.waitFor(() => expect(stub.hits).toBe(1));
      controller.abort();
      const result = await pending;
      expect(result).toEqual({ ok: false, message: 'Weather request was cancelled' });
      await vi.waitFor(() => expect(stub.closed).toBe(1)); // upstream saw the connection drop
      expect(stub.hits).toBe(1);
    } finally {
      process.env.WEATHER_FETCH_TIMEOUT_MS = '300';
    }
  });

  it('does not call upstream if already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await fetchWeather(0, 0, controller.signal);
    expect(result).toEqual({ ok: false, message: 'Weather request was cancelled' });
    expect(stub.hits).toBe(0);
  });
});
