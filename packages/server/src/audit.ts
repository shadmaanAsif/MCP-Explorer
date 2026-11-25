// Stage 10.4: an audit log. One JSON line per tool call that says who called
// what and how it ended. It records the tool NAME only, never the arguments or
// the result, because those can hold paths, locations or file contents.
// HTTP only: the stdio server has no callers to tell apart.

import { currentContext } from './log.js';

export type AuditEvent = {
  type: 'audit';
  time: string;
  /** Stage 12.1: the request this call belongs to, to match it with the other log lines. */
  req?: string;
  /** The token's `sub`, or null when auth is off. */
  sub: string | null;
  session: string | null;
  tool: string;
  decision: 'allowed' | 'denied';
  /** Scopes the caller lacked (denied only). */
  missing?: string[];
  /** How an allowed call ended (allowed only). */
  outcome?: 'ok' | 'error';
  ms?: number;
};

export type AuditSink = (event: AuditEvent) => void;

/** One line on stderr, easy to grep or ship: `grep '"type":"audit"'`. */
export const auditToStderr: AuditSink = (event) => {
  console.error(JSON.stringify(event));
};

export function auditEvent(
  fields: Omit<AuditEvent, 'type' | 'time'>,
  sink: AuditSink = auditToStderr
): void {
  const req = currentContext()?.req;
  sink({ type: 'audit', time: new Date().toISOString(), ...(req ? { req } : {}), ...fields });
}

type ToolExtra = { authInfo?: { clientId?: string }; sessionId?: string };
type CallRequest = { params?: { name?: unknown } };
type RequestHandler = (request: CallRequest, extra: ToolExtra) => Promise<unknown>;

/**
 * Wraps the SDK's one `tools/call` handler, so EVERY call leaves a line: any
 * tool (a new one needs no logging code), an unknown tool name, and a call
 * whose arguments fail validation before a tool handler would run.
 * The SDK registers that handler on its first `registerTool`, so this must be
 * installed before any tool is registered.
 */
export function auditTools(server: { server: { setRequestHandler: unknown } }, sink: AuditSink): void {
  const inner = server.server;
  const original = (inner.setRequestHandler as (...args: unknown[]) => unknown).bind(inner);
  inner.setRequestHandler = (schema: { shape?: { method?: { value?: string } } }, handler: RequestHandler) => {
    if (schema.shape?.method?.value !== 'tools/call') return original(schema, handler);
    return original(schema, async (request: CallRequest, extra: ToolExtra) => {
      const start = Date.now();
      let outcome: 'ok' | 'error' = 'ok';
      try {
        const result = (await handler(request, extra)) as { isError?: boolean } | undefined;
        if (result?.isError) outcome = 'error';
        return result;
      } catch (error) {
        outcome = 'error';
        throw error;
      } finally {
        auditEvent(
          {
            sub: extra?.authInfo?.clientId ?? null,
            session: extra?.sessionId ?? null,
            tool: typeof request.params?.name === 'string' ? request.params.name : 'unknown',
            decision: 'allowed',
            outcome,
            ms: Date.now() - start
          },
          sink
        );
      }
    });
  };
}
