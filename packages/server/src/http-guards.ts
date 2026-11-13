// Stage 10.2: the MCP spec says an HTTP server MUST validate the Origin header,
// so a web page in the user's browser cannot talk to a local server through
// DNS rebinding. Browsers always send Origin on cross-site requests; curl, the
// CLI client and Cursor send none, so a missing Origin is allowed.
import type { MiddlewareHandler } from 'hono';

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
