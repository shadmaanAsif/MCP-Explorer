import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type SessionState } from '../../src/create-server.js';

// A client and a server joined in one process by a pair of linked in-memory
// transports: the real protocol handshake and messages, with no port or process.
export async function connectInMemory(session: SessionState = {}) {
  const server = createServer(session);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}
