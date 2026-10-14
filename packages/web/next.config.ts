import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // This repo has a stray pnpm-lock.yaml alongside the real root
  // package-lock.json, which would otherwise make Next.js mis-infer the
  // monorepo root from lockfile detection — point it at the real root.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  // @modelcontextprotocol/sdk uses child_process.spawn for the stdio
  // transport — keep it (and this package's own client) out of server-side
  // bundling rather than letting the bundler try to trace through it.
  serverExternalPackages: ['@modelcontextprotocol/sdk', '@mcp-explorer/client']
};

export default nextConfig;
