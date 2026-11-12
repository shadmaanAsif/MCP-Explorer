// Runs `next dev` or `next start` with the port taken from WEB_PORT in
// packages/web/.env. Next loads that file itself for the server code, but the
// -p flag is decided here, before Next starts.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables already set

const command = process.argv[2]; // dev | start
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, command, '-p', process.env.WEB_PORT ?? '4767'], {
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
