import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// --- get_weather: talking to Open-Meteo without trusting it -----------------
// The upstream API can be slow, down, or reply with something unexpected, and
// none of that should hang the tool call or crash the server. Every failure
// below becomes a normal `isError: true` tool result with its own message.
// OPEN_METEO_URL exists so the failure paths can be exercised against a local
// stub server; it defaults to the real API.
const OPEN_METEO_URL = process.env.OPEN_METEO_URL ?? 'https://api.open-meteo.com/v1/forecast';
const FETCH_TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;

// Validates the reply instead of trusting its shape: if Open-Meteo changes
// its format (or a proxy returns an HTML error page), we want a clear error,
// not a TypeError from reading `data.current.temperature_2m` on undefined.
const weatherResponseSchema = z.object({
  current: z.object({ temperature_2m: z.number(), wind_speed_10m: z.number() }),
  current_units: z.object({ temperature_2m: z.string(), wind_speed_10m: z.string() })
});

type WeatherResult = { ok: true; text: string } | { ok: false; message: string };

// Resolves after `ms`, or immediately if the caller cancels while we wait.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

// `callerSignal` is the MCP request's own signal: it fires when the client
// cancels the call, so we stop hitting the upstream API on their behalf.
async function fetchWeather(latitude: number, longitude: number, callerSignal: AbortSignal): Promise<WeatherResult> {
  const url = `${OPEN_METEO_URL}?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m`;
  let lastFailure = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (callerSignal.aborted) return { ok: false, message: 'Weather request was cancelled' };

    // Each attempt gets its own timeout; the caller's signal is combined in so
    // either one aborts the request. This uses an AbortController + setTimeout
    // rather than AbortSignal.timeout(): on Node 20, a timeout signal that is
    // only referenced through AbortSignal.any() can be garbage-collected
    // before it fires, which left a hung upstream hanging the tool forever.
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, FETCH_TIMEOUT_MS);

    try {
      const signal = AbortSignal.any([callerSignal, timeoutController.signal]);
      const response = await fetch(url, { signal });

      if (response.ok) {
        // Bad data is not retried: asking again won't change the shape.
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return { ok: false, message: 'Open-Meteo returned a response that was not valid JSON' };
        }
        const parsed = weatherResponseSchema.safeParse(body);
        if (!parsed.success) {
          return { ok: false, message: 'Open-Meteo returned an unexpected response shape (missing current weather fields)' };
        }
        const { current, current_units } = parsed.data;
        return {
          ok: true,
          text: `${current.temperature_2m}${current_units.temperature_2m}, wind ${current.wind_speed_10m} ${current_units.wind_speed_10m}`
        };
      }

      // 4xx means our request was wrong — retrying can't fix it. 5xx means
      // their side is struggling — worth another try.
      const failure = `Open-Meteo returned ${response.status} ${response.statusText}`;
      if (response.status < 500) return { ok: false, message: failure };
      lastFailure = failure;
    } catch (error) {
      if (callerSignal.aborted) return { ok: false, message: 'Weather request was cancelled' };
      lastFailure = timedOut
        ? `Open-Meteo did not respond within ${FETCH_TIMEOUT_MS / 1000}s`
        : `Failed to reach Open-Meteo: ${(error as Error).message}`;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      console.error(`[mcp-demo] get_weather attempt ${attempt + 1} failed (${lastFailure}); retrying in ${delay}ms`);
      await sleep(delay, callerSignal);
    }
  }

  return { ok: false, message: `${lastFailure} (gave up after ${MAX_RETRIES + 1} attempts)` };
}

// Built by a factory (not a module-level singleton) so each transport can get
// its own instance: the stdio entry builds one, the stateless HTTP entry
// builds a fresh one per request.
// The server is the thing an MCP client (like Claude Desktop, Claude Code,
// or the MCP Inspector) connects to. Giving it a name/version is how it
// identifies itself during the initial handshake.
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'mcp-demo',
    version: '0.1.0'
  });

  // A "tool" is a function we expose to the client. The client can ask what
  // tools exist, see this description and inputSchema, and then call it with
  // arguments that match the schema.
  server.registerTool(
    'add',
    {
      title: 'Add two numbers',
      description: 'Adds two numbers together and returns their sum.',
      inputSchema: {
        a: z.number().describe('The first number'),
        b: z.number().describe('The second number')
      }
    },
    async ({ a, b }) => {
      console.error(`[mcp-demo] add called with a=${a}, b=${b}`);
      return {
        content: [
          {
            type: 'text',
            text: `${a + b}`
          }
        ]
      };
    }
  );

  // Stage 2's tool. "add" only needed zod to describe a *shape* (two numbers) —
  // any two numbers are valid. "divide" needs a *rule*: b can be any number
  // except zero. That's the difference between typing and validation — the
  // schema itself now rejects a bad call before our handler ever runs.
  server.registerTool(
    'divide',
    {
      title: 'Divide two numbers',
      description: 'Divides a by b and returns the quotient. Rejects division by zero.',
      inputSchema: {
        a: z.number().describe('The numerator'),
        b: z
          .number()
          .refine((value) => value !== 0, {
            message: 'b must not be zero — division by zero is undefined'
          })
          .describe('The denominator (must not be zero)')
      }
    },
    async ({ a, b }) => {
      console.error(`[mcp-demo] divide called with a=${a}, b=${b}`);
      return {
        content: [
          {
            type: 'text',
            text: `${a / b}`
          }
        ]
      };
    }
  );

  // Stage 3's tool. The first async handler that does real I/O instead of
  // pure math — a network call that can be slow or fail outright, not just
  // return a bad value. Uses Open-Meteo (no API key needed) to stay focused
  // on "async + a real external dependency" rather than credential handling.
  server.registerTool(
    'get_weather',
    {
      title: 'Get current weather',
      description: 'Fetches current temperature and wind speed for a latitude/longitude from Open-Meteo.',
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees'),
        longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees')
      }
    },
    async ({ latitude, longitude }, extra) => {
      console.error(`[mcp-demo] get_weather called with latitude=${latitude}, longitude=${longitude}`);
      const result = await fetchWeather(latitude, longitude, extra.signal);
      if (!result.ok) {
        return { isError: true, content: [{ type: 'text', text: result.message }] };
      }
      return { content: [{ type: 'text', text: result.text }] };
    }
  );

  return server;
}
