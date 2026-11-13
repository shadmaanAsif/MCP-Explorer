import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ReviewError } from './errors.js';
import { gitToplevel } from './git.js';
import { isInside, listRepoFiles } from './files.js';

let defaultRoot: Promise<string> | undefined;

// Folders the client says it is working in (MCP "roots"). Returns [] when the
// client does not support roots, or does not answer in time. A stateless HTTP
// server never sees the client's capabilities, so it always lands here.
export async function clientRoots(server: McpServer): Promise<string[]> {
  if (!server.server.getClientCapabilities()?.roots) return [];
  try {
    const { roots } = await server.server.listRoots(undefined, { timeout: 3000 });
    return roots.filter((r) => r.uri.startsWith('file://')).map((r) => fileURLToPath(r.uri));
  } catch {
    return [];
  }
}

// Optional allow-list (colon-separated). When set, a client-supplied root must
// sit inside one of these folders, so a client cannot point the server at "/".
async function isAllowedRoot(candidate: string): Promise<boolean> {
  const allowed = process.env.REVIEW_ALLOWED_ROOTS;
  if (!allowed) return true;
  for (const entry of allowed.split(':').filter(Boolean)) {
    if (isInside(await fs.realpath(entry).catch(() => entry), candidate)) return true;
  }
  return false;
}

// The review tools read the server's own disk and run its scripts. Over stdio
// that is the user's own machine, which is what they are for. Over HTTP the
// server is usually somewhere else, so they would look at the wrong disk, or
// expose the host. http.ts marks itself, and the tools then refuse with a
// message that says what to do. An admin can opt in with REVIEW_ALLOW_HTTP=1.
const HTTP_REFUSAL =
  'Code review tools are not available over HTTP: they read the disk of the machine the server runs on, not your project. ' +
  'Use the stdio server on your own machine (docs/connecting-clients.md, section 9). ' +
  'If you want them to run on this server, ask the server admin to set REVIEW_ALLOW_HTTP=1 and REVIEW_ALLOWED_ROOTS and restart it.';

export function assertReviewAllowed(): void {
  if (process.env.REVIEW_TRANSPORT === 'http' && process.env.REVIEW_ALLOW_HTTP !== '1') {
    throw new ReviewError(HTTP_REFUSAL);
  }
}

// An explicit `root` from a tool call (the model passes the project it is
// working in). It must exist and pass the allow-list, and it must agree with a
// pinned REVIEW_ROOT. A bad request is an error, never a silent fallback to a
// different repo.
async function resolveRequestedRoot(requested: string): Promise<string> {
  if (!path.isAbsolute(requested)) throw new ReviewError('root must be an absolute path');
  let real: string;
  try {
    real = await fs.realpath(requested);
  } catch {
    throw new ReviewError(`root does not exist: ${requested}`);
  }
  if (!(await fs.stat(real)).isDirectory()) throw new ReviewError(`root is not a folder: ${requested}`);
  if (!(await isAllowedRoot(real))) throw new ReviewError('root is outside REVIEW_ALLOWED_ROOTS');
  const top = await fs.realpath(await gitToplevel(real));
  const pinned = process.env.REVIEW_ROOT;
  if (pinned && top !== (await fs.realpath(pinned))) {
    throw new ReviewError('This server is pinned to one repo (REVIEW_ROOT); a different root is not allowed');
  }
  return top;
}

// Which repo to review, in order:
//   1. REVIEW_ROOT, an explicit operator setting, always wins (a `root`
//      argument may only name that same repo).
//   2. The `root` argument of the tool call.
//   3. The client's first root (its open project), if it declares roots.
//   4. The git root of wherever the server was started, unless
//      REVIEW_REQUIRE_ROOT=1, in which case the call fails.
// Read on every call so tests (and operators) can point it elsewhere.
export async function getRoot(server: McpServer, requested?: string): Promise<string> {
  assertReviewAllowed();
  if (requested) return resolveRequestedRoot(requested);
  const configured = process.env.REVIEW_ROOT;
  if (configured) return fs.realpath(configured);

  for (const root of await clientRoots(server)) {
    try {
      const real = await fs.realpath(root);
      if (await isAllowedRoot(real)) return fs.realpath(await gitToplevel(real));
      console.error(`[mcp-demo] ignoring client root outside REVIEW_ALLOWED_ROOTS: ${real}`);
    } catch {
      // root no longer exists; try the next one
    }
  }
  // A shared server has no meaningful start folder, so a call that names no
  // project must fail instead of quietly reviewing the server's own repo.
  if (process.env.REVIEW_REQUIRE_ROOT === '1') {
    throw new ReviewError(
      'No project to review. Pass `root` with the absolute path of the project (your open workspace folder).'
    );
  }
  return fs.realpath(await (defaultRoot ??= gitToplevel(process.cwd())));
}

// For the resource's list and completion callbacks, which cannot report an
// error to the user: no known project simply means no files.
export async function listFilesOrNone(server: McpServer): Promise<string[]> {
  try {
    return await listRepoFiles(await getRoot(server));
  } catch (err) {
    if (err instanceof ReviewError) return [];
    throw err;
  }
}
