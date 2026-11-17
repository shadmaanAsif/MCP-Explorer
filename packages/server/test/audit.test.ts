import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/create-server.js';
import { auditEvent, type AuditEvent } from '../src/audit.js';

async function connectAudited() {
  const events: AuditEvent[] = [];
  const server = createServer({}, (e) => events.push(e));
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, events, close: () => client.close() };
}

describe('auditEvent', () => {
  it('adds the type and an ISO time', () => {
    const seen: AuditEvent[] = [];
    auditEvent({ sub: 'alice', session: null, tool: 'add', decision: 'allowed', outcome: 'ok', ms: 1 }, (e) => seen.push(e));
    expect(seen[0]).toMatchObject({ type: 'audit', sub: 'alice', tool: 'add' });
    expect(new Date(seen[0].time).toISOString()).toBe(seen[0].time);
  });
});

describe('auditTools (every tool is wrapped)', () => {
  it('logs one allowed/ok event for a good call, with no argument values', async () => {
    const { client, events, close } = await connectAudited();
    await client.callTool({ name: 'add', arguments: { a: 4242, b: 7 } });
    await close();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: 'add', decision: 'allowed', outcome: 'ok', sub: null });
    expect(typeof events[0].ms).toBe('number');
    expect(JSON.stringify(events)).not.toContain('4242');
  });

  it('logs outcome error when the tool reports an error', async () => {
    const { client, events, close } = await connectAudited();
    const result = await client.callTool({ name: 'divide', arguments: { a: 1, b: 0 } });
    await close();
    expect(result.isError).toBe(true);
    expect(events.map((e) => [e.tool, e.outcome])).toEqual([['divide', 'error']]);
  });

  it('logs a call to an unknown tool as an error', async () => {
    const { client, events, close } = await connectAudited();
    await client.callTool({ name: 'no_such_tool', arguments: {} }).catch(() => undefined);
    await close();
    expect(events.map((e) => [e.tool, e.outcome])).toEqual([['no_such_tool', 'error']]);
  });

  it('logs nothing for listing tools', async () => {
    const { client, events, close } = await connectAudited();
    await client.listTools();
    await close();
    expect(events).toEqual([]);
  });

  it('wraps the review tools too, so a new tool needs no logging code', async () => {
    const { client, events, close } = await connectAudited();
    await client.callTool({ name: 'read_file', arguments: { path: '.env', root: '/nonexistent-secret-dir' } });
    await close();
    expect(events.map((e) => e.tool)).toEqual(['read_file']);
    expect(JSON.stringify(events)).not.toContain('nonexistent-secret-dir');
  });
});
