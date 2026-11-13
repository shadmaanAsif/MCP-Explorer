// Stage 10.1: what a token may do. Stage 9 proved WHO is calling; this decides
// WHAT they may call. One table maps each tool to the scope it needs, and one
// middleware (after bearerAuth) enforces it, so no tool has its own check.
import type { MiddlewareHandler } from 'hono';
import type { AuthInfo } from './middleware.js';

/** Needed to reach /mcp at all. */
export const BASE_SCOPE = 'mcp:tools';

export const TOOL_SCOPES: Record<string, string> = {
  add: 'weather:use',
  divide: 'weather:use',
  get_weather: 'weather:use',
  get_weather_batch: 'weather:use',
  set_home_location: 'weather:use',
  get_home_weather: 'weather:use',
  get_diff: 'review:read',
  read_file: 'review:read',
  // The only tool that starts processes on the server's machine.
  run_checks: 'review:run',
};

// Review prompt and resource read the repo, so they need review:read too.
const PROMPT_SCOPES: Record<string, string> = { review_code: 'review:read' };
const RESOURCE_PREFIX_SCOPES: [string, string][] = [['repo://', 'review:read']];

/** The scope one JSON-RPC message needs beyond the base scope, if any. */
export function requiredScope(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { method, params } = message as { method?: unknown; params?: { name?: unknown; uri?: unknown } };
  if (method === 'tools/call' && typeof params?.name === 'string') {
    // A tool nobody mapped needs a scope nobody has: unknown means denied.
    return TOOL_SCOPES[params.name] ?? `tool:${params.name}`;
  }
  if (method === 'prompts/get' && typeof params?.name === 'string') return PROMPT_SCOPES[params.name];
  if (method === 'resources/read' && typeof params?.uri === 'string') {
    return RESOURCE_PREFIX_SCOPES.find(([prefix]) => (params.uri as string).startsWith(prefix))?.[1];
  }
  return undefined;
}

export function scopeGuard(resourceMetadataUrl: string): MiddlewareHandler<{ Variables: { auth?: AuthInfo } }> {
  const deny = (c: Parameters<MiddlewareHandler>[0], needed: string[]) =>
    c.body(null, 403, {
      'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${needed.join(' ')}", resource_metadata="${resourceMetadataUrl}"`,
    });

  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return next(); // auth is off

    if (!auth.scopes.includes(BASE_SCOPE)) return deny(c, [BASE_SCOPE]);

    // Hono caches the parsed body, so the handlers can read it again after us.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return next(); // not JSON: the MCP handler answers with its own error
    }
    const messages = Array.isArray(body) ? body : [body];
    const missing = [
      ...new Set(
        messages.map(requiredScope).filter((s): s is string => s !== undefined && !auth.scopes.includes(s)),
      ),
    ];
    if (missing.length > 0) return deny(c, missing);
    return next();
  };
}
