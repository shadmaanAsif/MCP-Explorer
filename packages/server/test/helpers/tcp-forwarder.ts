import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { freePort } from './http-server.js';

// A tiny TCP forwarder in front of a real service. A test points the server at
// the forwarder instead of at Redis, and `down()` then looks to the server like
// Redis stopping: every open connection is cut and new ones are refused.
// `up()` listens on the same port again, like Redis starting back up. The
// shared Redis other tests use is never touched.
export type TcpForwarder = { port: number; down: () => Promise<void>; up: () => Promise<void>; close: () => Promise<void> };

export async function startTcpForwarder(target: { host: string; port: number }): Promise<TcpForwarder> {
  const port = await freePort();
  const sockets = new Set<Socket>();
  let server: Server | undefined;

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      const s = createServer((client) => {
        const upstream = createConnection(target);
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
          // A cut connection is the point of the test, not an error to report.
          socket.on('error', () => {});
        }
        client.pipe(upstream);
        upstream.pipe(client);
        client.once('close', () => upstream.destroy());
        upstream.once('close', () => client.destroy());
      });
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => {
        server = s;
        resolve();
      });
    });

  const down = async () => {
    const s = server;
    server = undefined;
    for (const socket of sockets) socket.destroy();
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  };

  await listen();
  return { port, down, up: listen, close: down };
}
