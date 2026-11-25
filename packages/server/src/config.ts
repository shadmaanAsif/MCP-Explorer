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
import { LOG_FORMATS, LOG_LEVELS, type LogFormat, type LogLevel } from './log.js';

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
    SESSION_STORE: z.enum(['memory', 'redis'], { error: 'must be memory or redis' }).default('memory'),
    REDIS_URL: z
      .string()
      .refine((v) => URL.canParse(v) && /^rediss?:$/.test(new URL(v).protocol), 'must be a redis:// or rediss:// URL')
      .optional(),
    RESUMABLE_STREAMS: z.enum(['0', '1'], { error: 'must be 0 or 1' }).default('0'),
    EVENT_STORE_MAX_EVENTS: whole.refine((n) => n >= 1, 'must be 1 or more').default(500),
    EVENT_STORE_TTL_MS: whole.refine((n) => n >= 1, 'must be 1 or more').default(5 * 60 * 1000),
    EVENT_STORE_DEBUG: z.enum(['0', '1'], { error: 'must be 0 or 1' }).default('0'),
    LOG_FORMAT: z.enum(LOG_FORMATS, { error: 'must be text or json' }).default('text'),
    LOG_LEVEL: z.enum(LOG_LEVELS, { error: 'must be debug, info, warn or error' }).default('info'),
    INSTANCE_ID: z
      .string()
      .regex(/^[\w.-]{1,64}$/, 'must be 1 to 64 letters, digits, dots, dashes or underscores')
      .optional(),
    // Stage 12.2: the admin listener (health now, metrics in 12.3). Off unless ADMIN_PORT is set.
    ADMIN_PORT: whole.refine((n) => n >= 1 && n <= 65535, 'must be between 1 and 65535').optional(),
    ADMIN_HOST: z
      .string()
      .regex(/^[\w.:-]{1,253}$/, 'must be a host name or an IP address')
      .default('127.0.0.1'),
    NODE_ENV: z.string().optional()
  })
  .superRefine((env, ctx) => {
    if (env.ADMIN_PORT !== undefined && env.ADMIN_PORT === (env.MCP_SERVER_PORT ?? env.PORT ?? 4768)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_PORT'],
        message: 'must differ from the MCP port (the admin listener is a separate port)'
      });
    }
    if (env.AUTH_REQUIRED === '1' && !env.ISSUER_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['ISSUER_URL'],
        message: 'is required when AUTH_REQUIRED=1 (the address of the token issuer)'
      });
    }
    if (env.SESSION_STORE === 'redis' && !env.REDIS_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'is required when SESSION_STORE=redis'
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
  sessionStore: 'memory' | 'redis';
  /** Never print this: it can contain a password. */
  redisUrl?: string;
  /** Stage 11.3: keep stream events so a dropped stream can resume. */
  resumableStreams: boolean;
  eventMaxPerStream: number;
  eventTtlMs: number;
  /** Log one line per stream event stored or replayed (no message content). */
  eventDebug: boolean;
  /** Stage 12.1: `text` keeps today's lines (plus a key=value tail); `json` is one object per line. */
  logFormat: LogFormat;
  logLevel: LogLevel;
  /** Tells instances apart in their logs. Default: the host name. */
  instanceId?: string;
  /** Stage 12.2: port of the admin listener (/healthz, /readyz). Undefined = no admin listener. */
  adminPort?: number;
  /** Where the admin listener binds. Default 127.0.0.1, so only this machine can reach it. */
  adminHost: string;
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
    ratePerMinute: v.RATE_LIMIT_PER_MINUTE,
    sessionStore: v.SESSION_STORE,
    redisUrl: v.REDIS_URL,
    resumableStreams: v.RESUMABLE_STREAMS === '1',
    eventMaxPerStream: v.EVENT_STORE_MAX_EVENTS,
    eventTtlMs: v.EVENT_STORE_TTL_MS,
    eventDebug: v.EVENT_STORE_DEBUG === '1',
    logFormat: v.LOG_FORMAT,
    logLevel: v.LOG_LEVEL,
    instanceId: v.INSTANCE_ID,
    adminPort: v.ADMIN_PORT,
    adminHost: v.ADMIN_HOST
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
