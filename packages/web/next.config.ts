import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // Point Next.js at the monorepo root explicitly rather than letting it
  // infer the root from lockfile detection.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  // @modelcontextprotocol/sdk uses child_process.spawn for the stdio
  // transport — keep it (and this package's own client) out of server-side
  // bundling rather than letting the bundler try to trace through it.
  serverExternalPackages: ['@modelcontextprotocol/sdk', '@mcp-explorer/client']
};

export default nextConfig;
