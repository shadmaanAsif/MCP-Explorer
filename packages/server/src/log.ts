// Stage 12.1: one logger for the whole server, instead of console.error calls
// scattered through the code. Two things it adds:
//
//  1. A request context. The HTTP middleware opens one per request, and every
//     log line written while that request runs (even deep inside the SDK or a
//     tool) carries its `req`, `session` and `sub` without being passed them.
//     That is what makes "grep one session across two instances" possible.
//  2. Two formats. `text` (the default) prints the same line as before plus a
//     short key=value tail; `json` prints one JSON object per line, for tools
//     that ship and search logs.
//
// Everything goes to stderr: over stdio, stdout is the protocol channel.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const LOG_FORMATS = ['text', 'json'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFormat = (typeof LOG_FORMATS)[number];
export type LogSettings = { format: LogFormat; level: LogLevel; instance: string };

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// ---- request context ----------------------------------------------------

/** What is known about the request being handled. */
export type RequestContext = { req?: string; session?: string; sub?: string };

// AsyncLocalStorage (built into Node) keeps a value for everything an async
// call starts: awaits, timers, promise chains. Code that never received the
// request can still read it.
const storage = new AsyncLocalStorage<RequestContext>();

/** A short random id for one request, e.g. `7f3a9c21`. */
export const newRequestId = (): string => randomBytes(4).toString('hex');

/** Runs `fn` with a fresh context; everything it awaits can read it. */
export const runWithContext = <T>(context: RequestContext, fn: () => T): T => storage.run(context, fn);

/** Adds facts learned mid-request (the session, the caller). A no-op outside a request. */
export function setContext(fields: RequestContext): void {
  const store = storage.getStore();
  if (!store) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) store[key as keyof RequestContext] = value;
  }
}

export const currentContext = (): RequestContext | undefined => storage.getStore();

// ---- the logger ---------------------------------------------------------

/**
 * Extra fields for one line. They win over the request context.
 * `err` is an Error (or anything thrown): its stack is printed after the message.
 * `bare: true` leaves out the `[mcp-demo] ` prefix in text mode, for the two
 * start-up lines that never had one. It is not printed.
 */
export type LogFields = { [key: string]: unknown; err?: unknown; bare?: boolean };

export type Logger = {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  configure(settings: Partial<LogSettings>): void;
  settings(): LogSettings;
};

// console.error, not process.stderr.write: it is the same stream, and tests
// that want quiet output already mock console.error.
const toStderr = (line: string) => console.error(line);

const errorText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));

// Values with spaces, quotes or `=` are quoted so `key=value` stays parseable.
const textValue = (value: unknown) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
};

export function createLogger(initial: Partial<LogSettings> = {}, write: (line: string) => void = toStderr): Logger {
  let settings: LogSettings = { format: 'text', level: 'info', instance: hostname(), ...initial };

  function emit(level: LogLevel, msg: string, fields: LogFields = {}) {
    if (RANK[level] < RANK[settings.level]) return;
    const { err, bare, ...extra } = fields;
    const context = storage.getStore() ?? {};
    // Order is fixed so lines look alike: who (instance, req, session, sub), then extras.
    const known: Record<string, unknown> = {
      req: extra.req ?? context.req,
      session: extra.session ?? context.session,
      sub: extra.sub ?? context.sub
    };
    delete extra.req;
    delete extra.session;
    delete extra.sub;
    const all = { ...known, ...extra };

    if (settings.format === 'json') {
      const line: Record<string, unknown> = { time: new Date().toISOString(), level, instance: settings.instance, ...all };
      if (err !== undefined) {
        line.err = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.stack) line.stack = err.stack;
      }
      line.msg = msg;
      write(JSON.stringify(line));
      return;
    }

    const tail = Object.entries({ ...all, instance: settings.instance })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${textValue(value)}`)
      .join(' ');
    const prefix = bare ? '' : '[mcp-demo] ';
    const body = err !== undefined ? `${msg} ${errorText(err)}` : msg;
    write(`${prefix}${body}${tail ? ` ${tail}` : ''}`);
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    configure: (next) => {
      // An undefined value (a setting that was not given) keeps the current one.
      settings = { ...settings, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) };
    },
    settings: () => settings
  };
}

/** The server's logger. The HTTP entry configures it from validated settings. */
export const log = createLogger();
export const configureLog = (settings: Partial<LogSettings>) => log.configure(settings);

/**
 * For the stdio entry, which has no validated config: read LOG_FORMAT, LOG_LEVEL
 * and INSTANCE_ID, and ignore a value that is not valid (the HTTP server is
 * strict about the same variables, in config.ts).
 */
export function logSettingsFromEnv(env: Record<string, string | undefined> = process.env): Partial<LogSettings> {
  const settings: Partial<LogSettings> = {};
  const format = env.LOG_FORMAT?.trim();
  const level = env.LOG_LEVEL?.trim();
  const instance = env.INSTANCE_ID?.trim();
  if ((LOG_FORMATS as readonly string[]).includes(format ?? '')) settings.format = format as LogFormat;
  if ((LOG_LEVELS as readonly string[]).includes(level ?? '')) settings.level = level as LogLevel;
  if (instance) settings.instance = instance;
  return settings;
}
