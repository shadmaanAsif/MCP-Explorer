// Stage 11.2: make a freshly built transport believe it served a session from
// the start. The transport only treats a session as initialised after it has
// handled `initialize`, so we replay the client's stored one (D1 A, proven in
// test/session-rebuild.test.ts). Only the public SDK API is used.
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { SessionState } from './create-server.js';

const URL_ = 'http://localhost/mcp';
const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

const post = (transport: WebStandardStreamableHTTPServerTransport, body: unknown, extra: Record<string, string> = {}) =>
  transport.handleRequest(
    new Request(URL_, { method: 'POST', headers: { ...HEADERS, ...extra }, body: JSON.stringify(body) })
  );

// The answer comes back as JSON or as a one-message SSE stream.
function protocolVersionOf(text: string, contentType: string | null): string | undefined {
  try {
    const json = contentType?.includes('text/event-stream')
      ? text.split('\n').find((l) => l.startsWith('data:'))?.slice(5)
      : text;
    return json ? (JSON.parse(json)?.result?.protocolVersion as string | undefined) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replay `initialize` and `notifications/initialized` into a transport that was
 * built with `sessionIdGenerator: () => sessionId`. The replayed answer is
 * thrown away: the real client sent a different request and gets its own answer.
 */
export async function replayInitialize(
  transport: WebStandardStreamableHTTPServerTransport,
  sessionId: string,
  initializeParams: unknown
): Promise<void> {
  const init = await post(transport, { jsonrpc: '2.0', id: 'rebuild-initialize', method: 'initialize', params: initializeParams });
  const version =
    protocolVersionOf(await init.text(), init.headers.get('content-type')) ??
    (initializeParams as { protocolVersion?: string } | undefined)?.protocolVersion;
  if (!init.ok || !version) throw new Error('could not replay initialize');
  const done = await post(
    transport,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { 'mcp-session-id': sessionId, 'mcp-protocol-version': version }
  );
  await done.text();
  if (!done.ok) throw new Error('could not replay notifications/initialized');
}

/**
 * Stage 11.4: a live session reads its record on every request, and another
 * instance may have saved a newer state since this one last loaded or saved it
 * (the proxy sends one session's requests to both). Take the record's state in.
 *
 * It copies into the existing `state` object, because the tools hold a reference
 * to that object and replacing it would leave them reading the old one.
 *
 * `savedState` is the JSON this instance last loaded or wrote. A state that no
 * longer matches it is a change made here that is not written back yet (a request
 * is still running), so it is kept and the record is left for the write-back to
 * overwrite: last writer wins. Returns whether the state changed.
 */
export function adoptStoredState(session: { state: SessionState; savedState: string }, stored: SessionState): boolean {
  if (stored === session.state) return false; // the memory store hands back the same object
  const storedJson = JSON.stringify(stored);
  if (storedJson === session.savedState) return false; // nothing newer in the store
  if (JSON.stringify(session.state) !== session.savedState) return false; // an unsaved local change wins
  for (const key of Object.keys(session.state)) delete (session.state as Record<string, unknown>)[key];
  Object.assign(session.state, structuredClone(stored));
  session.savedState = storedJson;
  return true;
}
