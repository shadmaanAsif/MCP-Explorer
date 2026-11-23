// Stage 11.1 spike: can a SECOND, freshly built server + transport take over a
// session id it never issued? Instance A creates a session. Instance B knows
// only the stored id, then replays `initialize` through the public API with
// sessionIdGenerator returning that stored id. No private SDK fields are used.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from '../src/create-server.js';
import { replayInitialize } from '../src/session-rebuild.js';

const URL_ = 'http://localhost/mcp';
const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

const post = (transport: WebStandardStreamableHTTPServerTransport, body: unknown, extra: Record<string, string> = {}) =>
  transport.handleRequest(
    new Request(URL_, { method: 'POST', headers: { ...HEADERS, ...extra }, body: JSON.stringify(body) })
  );

// A POST answers as JSON or as a one-message SSE stream. Return the JSON-RPC message.
async function messageOf(res: Response): Promise<any> {
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text.split('\n').find((l) => l.startsWith('data:'));
    return data ? JSON.parse(data.slice(5)) : undefined;
  }
  return text ? JSON.parse(text) : undefined;
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'spike', version: '0' } }
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const CALL_ADD = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add', arguments: { a: 2, b: 3 } } };

async function newInstance(sessionIdGenerator: () => string) {
  const server = createServer({});
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator });
  await server.connect(transport);
  return { server, transport };
}

describe('session rebuild (Stage 11.1 spike)', () => {
  it('a second instance can adopt a stored session id by replaying initialize', async () => {
    // Instance A: a normal session.
    const a = await newInstance(randomUUID);
    const initRes = await post(a.transport, INIT);
    const sessionId = initRes.headers.get('mcp-session-id')!;
    const initMsg = await messageOf(initRes);
    expect(sessionId).toMatch(/[0-9a-f-]{36}/);
    const version = initMsg.result.protocolVersion as string;
    await post(a.transport, INITIALIZED, { 'mcp-session-id': sessionId, 'mcp-protocol-version': version });

    // Instance A dies. Instance B has only what a store would hold: the id and
    // the client's initialize params.
    await a.transport.close();
    const b = await newInstance(() => sessionId);
    const replay = await post(b.transport, { ...INIT, id: 'replay' });
    expect(replay.status).toBe(200);
    await replay.text(); // the replayed answer is discarded
    await post(b.transport, INITIALIZED, { 'mcp-session-id': sessionId, 'mcp-protocol-version': version });
    expect(b.transport.sessionId).toBe(sessionId);

    // The client's next request, with the OLD id, is answered by B.
    const res = await post(b.transport, CALL_ADD, { 'mcp-session-id': sessionId, 'mcp-protocol-version': version });
    expect(res.status).toBe(200);
    const msg = await messageOf(res);
    expect(msg.result.content[0].text).toBe('5');

    await b.transport.close();
  });

  it('the rebuilt instance still refuses a different session id', async () => {
    const id = randomUUID();
    const b = await newInstance(() => id);
    await (await post(b.transport, INIT)).text();
    await post(b.transport, INITIALIZED, { 'mcp-session-id': id, 'mcp-protocol-version': '2025-06-18' });
    const res = await post(b.transport, CALL_ADD, { 'mcp-session-id': randomUUID(), 'mcp-protocol-version': '2025-06-18' });
    expect(res.status).toBe(404);
    await b.transport.close();
  });

  it('replayInitialize (used by http.ts) rebuilds a session from the stored id and initialize params', async () => {
    const id = randomUUID();
    const b = await newInstance(() => id);
    await replayInitialize(b.transport, id, INIT.params);
    expect(b.transport.sessionId).toBe(id);
    const res = await post(b.transport, CALL_ADD, { 'mcp-session-id': id, 'mcp-protocol-version': '2025-06-18' });
    expect(res.status).toBe(200);
    expect((await messageOf(res)).result.content[0].text).toBe('5');
    await b.transport.close();
  });

  it('replayInitialize fails loudly when the initialize params are unusable', async () => {
    const id = randomUUID();
    const b = await newInstance(() => id);
    await expect(replayInitialize(b.transport, id, { nonsense: true })).rejects.toThrow('could not replay');
    await b.transport.close();
  });
});
