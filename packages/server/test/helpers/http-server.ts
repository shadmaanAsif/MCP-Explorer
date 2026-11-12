import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const HTTP_ENTRY = fileURLToPath(new URL('../../build/http.js', import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export type HttpServer = { url: string; logs: () => string; stop: () => Promise<void> };

// Starts the real compiled HTTP entry on a free port and waits until it says
// it is listening. `env` carries the mode, TTL and the stub weather URL.
export async function startHttpServer(env: Record<string, string>): Promise<HttpServer> {
  const port = await freePort();
  let output = '';
  const child: ChildProcess = spawn(process.execPath, [HTTP_ENTRY], {
    env: { ...process.env, PORT: String(port), MCP_SERVER_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10_000);
    const check = setInterval(() => {
      if (output.includes('server running on')) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 20);
    child.once('exit', (code) => {
      clearTimeout(timer);
      clearInterval(check);
      reject(new Error(`server exited early (${code}):\n${output}`));
    });
  });

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    logs: () => output,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      })
  };
}
