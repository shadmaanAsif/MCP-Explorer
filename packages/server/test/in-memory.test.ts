import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { connectInMemory } from './helpers/connect.js';
import { startWeatherStub, type WeatherStub } from './helpers/stub-weather.js';

type Connected = Awaited<ReturnType<typeof connectInMemory>>;
let stub: WeatherStub;
let c: Connected;

const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;

beforeAll(async () => {
  stub = await startWeatherStub();
  process.env.OPEN_METEO_URL = stub.url;
  process.env.WEATHER_FETCH_TIMEOUT_MS = '300';
  process.env.WEATHER_RETRY_BASE_DELAY_MS = '10';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(async () => {
  vi.restoreAllMocks();
  delete process.env.OPEN_METEO_URL;
  delete process.env.WEATHER_FETCH_TIMEOUT_MS;
  delete process.env.WEATHER_RETRY_BASE_DELAY_MS;
  await stub.close();
});
beforeEach(async () => {
  stub.mode = 'ok';
  stub.hits = 0;
  c = await connectInMemory();
});
afterEach(async () => {
  await c.close();
});

describe('capabilities', () => {
  it('declares tools, resources, prompts and completions', () => {
    const caps = c.client.getServerCapabilities();
    expect(caps).toMatchObject({ tools: {}, resources: {}, prompts: {}, completions: {} });
  });
});

describe('tools', () => {
  it('add returns the sum', async () => {
    expect(textOf(await c.client.callTool({ name: 'add', arguments: { a: 2, b: 3 } }))).toBe('5');
  });

  it('divide returns the quotient', async () => {
    expect(textOf(await c.client.callTool({ name: 'divide', arguments: { a: 10, b: 4 } }))).toBe('2.5');
  });

  it('divide rejects zero before the handler runs', async () => {
    const outcome = await c.client.callTool({ name: 'divide', arguments: { a: 1, b: 0 } }).then(
      (result) => result,
      (error) => error
    );
    // The SDK reports an invalid-argument call either as an error result or a thrown McpError.
    const message = outcome instanceof Error ? outcome.message : textOf(outcome);
    expect(outcome instanceof Error || (outcome as { isError?: boolean }).isError).toBeTruthy();
    expect(message).toContain('b must not be zero');
  });

  it('rejects out-of-range coordinates', async () => {
    const outcome = await c.client
      .callTool({ name: 'get_weather', arguments: { latitude: 120, longitude: 0 } })
      .then((r) => r, (e) => e);
    expect(outcome instanceof Error || (outcome as { isError?: boolean }).isError).toBeTruthy();
    expect(stub.hits).toBe(0);
  });

  it('get_weather returns the formatted reading', async () => {
    const result = await c.client.callTool({ name: 'get_weather', arguments: { latitude: 25.2, longitude: 55.27 } });
    expect(textOf(result)).toBe('12.3°C, wind 4.5 km/h');
  });

  it('get_weather turns an upstream failure into an isError result', async () => {
    stub.mode = '404';
    const result = await c.client.callTool({ name: 'get_weather', arguments: { latitude: 0, longitude: 0 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Open-Meteo returned 404 Not Found');
  });
});

describe('get_weather_batch', () => {
  const locations = [
    { name: 'Dubai', latitude: 25.2, longitude: 55.27 },
    { name: 'Delhi', latitude: 28.6, longitude: 77.2 },
    { name: 'London', latitude: 51.5, longitude: -0.1 }
  ];

  it('reports progress after each location when the client asks', async () => {
    const updates: { progress: number; total?: number; message?: string }[] = [];
    const result = await c.client.callTool(
      { name: 'get_weather_batch', arguments: { locations } },
      undefined,
      { onprogress: (p) => updates.push(p) }
    );
    expect(updates.map((u) => [u.progress, u.total])).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(updates[0].message).toBe('Dubai done');
    expect(result.isError).toBe(false);
    expect(textOf(result).split('\n')).toHaveLength(3);
  });

  it('sends no progress when the client does not ask', async () => {
    const seen: unknown[] = [];
    c.client.fallbackNotificationHandler = async (n) => void seen.push(n);
    await c.client.callTool({ name: 'get_weather_batch', arguments: { locations } });
    expect(seen).toEqual([]);
  });

  it('keeps going when one location fails, and is not an error overall', async () => {
    const result = await c.client.callTool(
      { name: 'get_weather_batch', arguments: { locations } },
      undefined,
      {
        // After the first location is done, make the upstream answer 404.
        onprogress: (p) => {
          if (p.progress === 1) stub.mode = '404';
        }
      }
    );
    const lines = textOf(result).split('\n');
    expect(lines[0]).toContain('Dubai: 12.3°C');
    expect(lines[1]).toContain('Delhi: ERROR - Open-Meteo returned 404');
    expect(lines[2]).toContain('London: ERROR');
    expect(result.isError).toBe(false);
  });

  it('is an error only when every location fails', async () => {
    stub.mode = '404';
    const result = await c.client.callTool({ name: 'get_weather_batch', arguments: { locations } });
    expect(result.isError).toBe(true);
  });

  it('rejects zero or more than 5 locations', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}`, latitude: 0, longitude: 0 }));
    for (const bad of [[], six]) {
      const outcome = await c.client
        .callTool({ name: 'get_weather_batch', arguments: { locations: bad } })
        .then((r) => r, (e) => e);
      expect(outcome instanceof Error || (outcome as { isError?: boolean }).isError).toBeTruthy();
    }
    expect(stub.hits).toBe(0);
  });
});

describe('session state', () => {
  it('get_home_weather errors before a home is set', async () => {
    const result = await c.client.callTool({ name: 'get_home_weather', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No home location set');
  });

  it('remembers the home location within one connection', async () => {
    await c.client.callTool({ name: 'set_home_location', arguments: { name: 'Home', latitude: 1, longitude: 2 } });
    expect(textOf(await c.client.callTool({ name: 'get_home_weather', arguments: {} }))).toBe('Home: 12.3°C, wind 4.5 km/h');
    const resource = await c.client.readResource({ uri: 'session://home' });
    expect(JSON.parse((resource.contents[0] as { text: string }).text)).toEqual({ name: 'Home', latitude: 1, longitude: 2 });
  });

  it('keeps two connections separate', async () => {
    const other = await connectInMemory();
    try {
      await c.client.callTool({ name: 'set_home_location', arguments: { name: 'A', latitude: 1, longitude: 1 } });
      const result = await other.client.callTool({ name: 'get_home_weather', arguments: {} });
      expect(result.isError).toBe(true); // the other connection never set a home
    } finally {
      await other.close();
    }
  });
});

describe('resources', () => {
  it('lists the fixed resources plus one per city', async () => {
    const { resources } = await c.client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('weather://cities');
    expect(uris).toContain('session://home');
    expect(uris.filter((u) => u.startsWith('weather://city/'))).toHaveLength(5);
  });

  it('lists the city template', async () => {
    const { resourceTemplates } = await c.client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(['weather://city/{name}']);
  });

  it('reads one city', async () => {
    const { contents } = await c.client.readResource({ uri: 'weather://city/dubai' });
    expect(JSON.parse((contents[0] as { text: string }).text)).toEqual({ name: 'Dubai', latitude: 25.2048, longitude: 55.2708 });
  });

  it('reads the whole city table', async () => {
    const { contents } = await c.client.readResource({ uri: 'weather://cities' });
    expect(Object.keys(JSON.parse((contents[0] as { text: string }).text))).toEqual(['dubai', 'delhi', 'london', 'tokyo', 'new-york']);
  });

  it('throws -32602 for an unknown city', async () => {
    const error = await c.client.readResource({ uri: 'weather://city/atlantis' }).catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(ErrorCode.InvalidParams);
    expect(error.message).toContain('Unknown city "atlantis"');
  });
});

describe('prompts', () => {
  it('lists both prompts', async () => {
    const { prompts } = await c.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['compare_weather', 'weather_report']);
  });

  it('compare_weather builds a message naming both cities and the tool', async () => {
    const { messages } = await c.client.getPrompt({ name: 'compare_weather', arguments: { cityA: 'dubai', cityB: 'delhi' } });
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('Dubai and Delhi');
    expect(text).toContain('get_weather_batch');
  });

  it('weather_report uses the style and coordinates', async () => {
    const { messages } = await c.client.getPrompt({ name: 'weather_report', arguments: { city: 'london', style: 'brief' } });
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('brief weather report for London');
    expect(text).toContain('51.5072');
  });

  it('rejects a missing argument and an unknown city with -32602', async () => {
    const missing = await c.client.getPrompt({ name: 'compare_weather', arguments: { cityA: 'dubai' } }).catch((e) => e);
    expect(missing.code).toBe(ErrorCode.InvalidParams);
    const unknown = await c.client.getPrompt({ name: 'weather_report', arguments: { city: 'atlantis', style: 'brief' } }).catch((e) => e);
    expect(unknown.code).toBe(ErrorCode.InvalidParams);
    expect(unknown.message).toContain('Unknown city');
  });
});

describe('completions', () => {
  const complete = (ref: object, name: string, value: string) =>
    c.client.complete({ ref: ref as never, argument: { name, value } });

  it('completes prompt city arguments by prefix', async () => {
    const result = await complete({ type: 'ref/prompt', name: 'compare_weather' }, 'cityA', 'd');
    expect(result.completion.values).toEqual(['dubai', 'delhi']);
  });

  it('completes the style argument', async () => {
    const result = await complete({ type: 'ref/prompt', name: 'weather_report' }, 'style', 'de');
    expect(result.completion.values).toEqual(['detailed']);
  });

  it('completes the resource template variable', async () => {
    const result = await complete({ type: 'ref/resource', uri: 'weather://city/{name}' }, 'name', 'n');
    expect(result.completion.values).toEqual(['new-york']);
  });

  it('returns nothing for a prefix that matches no city', async () => {
    const result = await complete({ type: 'ref/prompt', name: 'compare_weather' }, 'cityA', 'zz');
    expect(result.completion.values).toEqual([]);
  });
});
