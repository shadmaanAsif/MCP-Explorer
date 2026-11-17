// Stage 10.5: every setting the HTTP server reads, checked once at startup.
// A bad value stops the server with a message that names the variable, so a
// typo like AUTH_REQUIRED=true cannot silently leave the server open.
// Messages never print the value itself, in case a variable ever holds a secret.
import { z } from 'zod';
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_RATE_PER_MINUTE,
  parseAllowedOrigins
} from './http-guards.js';

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const whole = z.string().regex(/^\d+$/, 'must be a whole number, 0 or more').transform(Number);
const httpUrl = z
  .string()
  .refine((v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol), 'must be an http(s) URL');

const schema = z
  .object({
    MCP_SERVER_PORT: whole.refine((n) => n >= 1 && n <= 65535, 'must be between 1 and 65535').optional(),
    PORT: whole.refine((n) => n >= 1 && n <= 65535, 'must be between 1 and 65535').optional(),
    MCP_SERVER_URL: httpUrl.optional(),
    ISSUER_URL: httpUrl.optional(),
    MCP_MODE: z.enum(['stateful', 'stateless'], { error: 'must be stateful or stateless' }).default('stateful'),
    MCP_SESSION_TTL_MS: whole.refine((n) => n >= 1, 'must be 1 or more').default(30 * 60 * 1000),
    AUTH_REQUIRED: z.enum(['0', '1'], { error: 'must be 0 or 1' }).default('0'),
    AUTH_SCOPE: z.string().default('mcp:tools'),
    ALLOWED_ORIGINS: z
      .string()
      .refine(
        (v) =>
          v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .every((o) => URL.canParse(o) && /^https?:$/.test(new URL(o).protocol)),
        'must be a comma-separated list of http(s) origins'
      )
      .optional(),
    MAX_BODY_BYTES: whole.refine((n) => n >= 1, 'must be 1 or more').default(DEFAULT_MAX_BODY_BYTES),
    RATE_LIMIT_PER_MINUTE: whole.default(DEFAULT_RATE_PER_MINUTE),
    NODE_ENV: z.string().optional()
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_REQUIRED === '1' && !env.ISSUER_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['ISSUER_URL'],
        message: 'is required when AUTH_REQUIRED=1 (the address of the token issuer)'
      });
    }
    if (env.NODE_ENV === 'production' && env.AUTH_REQUIRED !== '1') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_REQUIRED'],
        message: 'must be 1 when NODE_ENV=production (the server will not start open to everyone)'
      });
    }
  });

export type Config = {
  port: number;
  mcpServerUrl: string;
  issuerUrl: string;
  mode: 'stateful' | 'stateless';
  sessionTtlMs: number;
  authRequired: boolean;
  authScope: string;
  allowedOrigins: string[];
  maxBodyBytes: number;
  ratePerMinute: number;
};

export const MCP_PATH = '/mcp';

// An empty variable (`FOO=` in a .env file) counts as not set.
function present(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = env[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(present(env));
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`));
  }
  const v = parsed.data;
  const port = v.MCP_SERVER_PORT ?? v.PORT ?? 4768;
  return {
    port,
    mcpServerUrl: v.MCP_SERVER_URL ?? `http://localhost:${port}${MCP_PATH}`,
    issuerUrl: v.ISSUER_URL ?? 'http://localhost:4769',
    mode: v.MCP_MODE,
    sessionTtlMs: v.MCP_SESSION_TTL_MS,
    authRequired: v.AUTH_REQUIRED === '1',
    authScope: v.AUTH_SCOPE,
    allowedOrigins: parseAllowedOrigins(v.ALLOWED_ORIGINS),
    maxBodyBytes: v.MAX_BODY_BYTES,
    ratePerMinute: v.RATE_LIMIT_PER_MINUTE
  };
}

// For the entry point: print the problems and exit 1, with no stack trace.
export function loadConfigOrExit(env: Record<string, string | undefined> = process.env): Config {
  try {
    return loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
