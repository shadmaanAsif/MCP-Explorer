import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// --- Code review (Stage 8) ---------------------------------------------------
// The server does not review anything. The client's model does. The server
// only supplies what the model needs, using all three primitives:
//   - prompt   review_code      the checklist the user picks
//   - tools    get_diff, read_file     read-only fetches the model decides to make
//              run_checks               lint/build/test with progress + cancel
//   - resource repo://file/{+path}      repo files the user can attach as context
//
// This is the first code that touches the filesystem and starts processes for
// a caller, and auth is still two stages away. So every input is checked here:
// paths must stay inside the repo root, git refs cannot look like options, and
// run_checks can only run names from a fixed list, never a command string.

const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 200_000;
const MAX_DIFF_BYTES = 100_000;
const MAX_LISTED_FILES = 200;
const MAX_CHECK_OUTPUT_CHARS = 4000;
const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const REVIEW_FOCUSES = ['all', 'bugs', 'security', 'style', 'tests'];

// The only things run_checks may run: `pnpm run <script>` in the repo root.
// The caller picks a name; it never supplies the command.
const CHECKS = ['build', 'test', 'typecheck'] as const;
type CheckName = (typeof CHECKS)[number];

// Thrown for bad input. Tools turn it into an isError result; resource reads
// turn it into a protocol error.
class ReviewError extends Error {}

function reviewTimeoutMs(): number {
  const parsed = Number(process.env.REVIEW_CHECK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHECK_TIMEOUT_MS;
}

// --- repo root ---------------------------------------------------------------

let defaultRoot: Promise<string> | undefined;

async function gitToplevel(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim();
  } catch {
    return cwd;
  }
}

// Folders the client says it is working in (MCP "roots"). Returns [] when the
// client does not support roots, or does not answer in time. A stateless HTTP
// server never sees the client's capabilities, so it always lands here.
async function clientRoots(server: McpServer): Promise<string[]> {
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

function assertReviewAllowed(): void {
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
async function getRoot(server: McpServer, requested?: string): Promise<string> {
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
async function listFilesOrNone(server: McpServer): Promise<string[]> {
  try {
    return await listRepoFiles(await getRoot(server));
  } catch (err) {
    if (err instanceof ReviewError) return [];
    throw err;
  }
}

// The branch a review should compare against when the caller names none: the
// remote's default branch, else the first of develop/main/master that exists.
async function defaultBaseBranch(root: string): Promise<string | undefined> {
  const git = (args: string[]) => execFileAsync('git', args, { cwd: root }).then((r) => r.stdout.trim());
  try {
    const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (head) return head;
  } catch {
    // no origin/HEAD; fall through to the usual names
  }
  for (const name of ['develop', 'main', 'master']) {
    try {
      await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      return name;
    } catch {
      // not there; try the next
    }
  }
  return undefined;
}

// --- path guard ----------------------------------------------------------------

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Files a reviewer has no business reading, even inside the repo.
function isBlocked(relativePath: string): boolean {
  const segments = relativePath.split(path.sep);
  const base = segments[segments.length - 1] ?? '';
  return (
    segments.includes('.git') ||
    base.startsWith('.env') ||
    base === 'id_rsa' ||
    base === 'id_ed25519' ||
    /\.(pem|key|p12|pfx)$/i.test(base)
  );
}

// Returns the real path of a file that is safe to read. Resolves symlinks
// first, so a link inside the repo that points outside it is refused.
async function resolveSafe(root: string, relativePath: string): Promise<string> {
  if (relativePath.includes('\0')) throw new ReviewError('Invalid path');
  if (path.isAbsolute(relativePath)) throw new ReviewError('Path must be relative to the repo root');

  const joined = path.resolve(root, relativePath);
  if (!isInside(root, joined)) throw new ReviewError('Path is outside the repo root');

  let real: string;
  try {
    real = await fs.realpath(joined);
  } catch {
    throw new ReviewError(`File not found: ${relativePath}`);
  }
  if (!isInside(root, real)) throw new ReviewError('Path is outside the repo root');
  if (isBlocked(path.relative(root, real))) throw new ReviewError('Reading this file is not allowed');
  return real;
}

async function readRepoFile(root: string, relativePath: string): Promise<string> {
  const real = await resolveSafe(root, relativePath);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new ReviewError(`Not a file: ${relativePath}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new ReviewError(`File is too large (${stat.size} bytes, limit ${MAX_FILE_BYTES})`);
  }
  return fs.readFile(real, 'utf8');
}

async function listRepoFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    return stdout
      .split('\n')
      .filter((file) => file !== '' && !isBlocked(file))
      .slice(0, MAX_LISTED_FILES);
  } catch {
    return [];
  }
}

// --- git diff --------------------------------------------------------------------

// A ref is a branch, tag, sha or things like HEAD~1. It must start with a
// letter or digit so it can never be read by git as an option (--output=...),
// and must not contain `..` so it cannot smuggle in its own range.
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@~^-]*$/;

function checkRef(label: string, ref: string): void {
  if (!REF_PATTERN.test(ref) || ref.includes('..')) {
    throw new ReviewError(`Invalid ${label} ref "${ref}"`);
  }
}

function truncate(text: string, limit: number, what: string): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n[${what} truncated at ${limit} characters]`;
}

async function gitDiff(root: string, base: string, head: string, signal: AbortSignal): Promise<string> {
  checkRef('base', base);
  checkRef('head', head);
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        'diff',
        '--no-color',
        '--no-ext-diff',
        `${base}...${head}`,
        '--',
        // Keep secrets out of the diff even if someone committed them.
        ':(exclude,glob)**/.env*',
        ':(exclude,glob)**/*.pem',
        ':(exclude,glob)**/*.key'
      ],
      { cwd: root, maxBuffer: 10 * 1024 * 1024, signal }
    );
    return stdout === '' ? '(no differences)' : truncate(stdout, MAX_DIFF_BYTES, 'Diff');
  } catch (err) {
    if (signal.aborted) throw new ReviewError('Diff was cancelled');
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new ReviewError(`git diff failed: ${stderr || (err as Error).message}`);
  }
}

// --- run_checks ------------------------------------------------------------------

type CheckResult = {
  name: CheckName;
  status: 'passed' | 'failed' | 'cancelled' | 'timed out';
  exitCode: number | null;
  output: string;
};

async function runCheck(name: CheckName, root: string, callerSignal: AbortSignal): Promise<CheckResult> {
  // A manual timer, not AbortSignal.timeout: that one can be garbage-collected
  // inside AbortSignal.any on Node 20 and never fire (see fetchWeather).
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, reviewTimeoutMs());
  const signal = AbortSignal.any([callerSignal, timeoutController.signal]);

  let output = '';
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-MAX_CHECK_OUTPUT_CHARS * 2);
  };

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      // No shell, and only `pnpm run <known script>`: nothing from the caller
      // reaches the command line.
      const child = spawn('pnpm', ['run', name], { cwd: root, signal, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });
    return { name, status: exitCode === 0 ? 'passed' : 'failed', exitCode, output: output.slice(-MAX_CHECK_OUTPUT_CHARS) };
  } catch (err) {
    if (callerSignal.aborted) return { name, status: 'cancelled', exitCode: null, output: output.slice(-MAX_CHECK_OUTPUT_CHARS) };
    if (timedOut) return { name, status: 'timed out', exitCode: null, output: output.slice(-MAX_CHECK_OUTPUT_CHARS) };
    return { name, status: 'failed', exitCode: null, output: `Could not start: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

// --- registration ----------------------------------------------------------------

// The second content item names the repo that was used, so a wrong repo is
// visible instead of silent.
const usedRoot = (root: string) => ({ type: 'text' as const, text: `[repo: ${root}]` });
const textResult = (text: string, root?: string) => ({
  content: [{ type: 'text' as const, text }, ...(root ? [usedRoot(root)] : [])]
});
const errorResult = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

export function registerReview(server: McpServer): void {
  server.registerTool(
    'get_diff',
    {
      title: 'Get a git diff',
      description:
        'Returns the changes on `head` since it diverged from `base` (git diff base...head) in the review repo. Read-only.',
      inputSchema: {
        base: z.string().min(1).describe('Base ref, for example main'),
        head: z.string().min(1).default('HEAD').describe('Head ref, for example a branch name. Defaults to HEAD'),
        root: z
          .string()
          .optional()
          .describe('Absolute path of the project to review (your open workspace folder). Defaults to the server\'s own choice')
      }
    },
    async ({ base, head, root: requested }, extra) => {
      console.error(`[mcp-demo] get_diff ${base}...${head}`);
      try {
        const root = await getRoot(server, requested);
        return textResult(await gitDiff(root, base, head, extra.signal), root);
      } catch (err) {
        if (err instanceof ReviewError) return errorResult(err.message);
        throw err;
      }
    }
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read a repo file',
      description: 'Returns the text of one file in the review repo. Read-only; paths outside the repo are refused.',
      inputSchema: {
        path: z.string().min(1).describe('Path relative to the repo root, for example packages/server/src/http.ts'),
        root: z
          .string()
          .optional()
          .describe('Absolute path of the project to review (your open workspace folder). Defaults to the server\'s own choice')
      }
    },
    async ({ path: relativePath, root: requested }) => {
      console.error(`[mcp-demo] read_file ${relativePath}`);
      try {
        const root = await getRoot(server, requested);
        return textResult(await readRepoFile(root, relativePath), root);
      } catch (err) {
        if (err instanceof ReviewError) return errorResult(err.message);
        throw err;
      }
    }
  );

  // `{+path}` (reserved expansion) lets the variable contain slashes.
  server.registerResource(
    'repo-file',
    new ResourceTemplate('repo://file/{+path}', {
      list: async () => ({
        resources: (await listFilesOrNone(server)).map((file) => ({
          uri: `repo://file/${file}`,
          name: file,
          mimeType: 'text/plain'
        }))
      }),
      complete: {
        path: async (typed) => (await listFilesOrNone(server)).filter((file) => file.startsWith(typed)).slice(0, 20)
      }
    }),
    {
      title: 'Repo file',
      description: 'The text of one tracked file in the review repo, for attaching as context.',
      mimeType: 'text/plain'
    },
    async (uri, variables) => {
      try {
        const text = await readRepoFile(await getRoot(server), String(variables.path));
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
      } catch (err) {
        if (err instanceof ReviewError) throw new McpError(ErrorCode.InvalidParams, err.message);
        throw err;
      }
    }
  );

  server.registerTool(
    'run_checks',
    {
      title: 'Run project checks',
      description:
        'Runs named checks (pnpm run build / test / typecheck) in the review repo, one after another, and reports progress after each. Cancel stops the running check.',
      inputSchema: {
        checks: z.array(z.enum(CHECKS)).min(1).max(CHECKS.length).describe('Which checks to run, in order'),
        root: z
          .string()
          .optional()
          .describe('Absolute path of the project to review (your open workspace folder). Defaults to the server\'s own choice')
      }
    },
    async ({ checks, root: requested }, extra) => {
      console.error(`[mcp-demo] run_checks ${checks.join(', ')}`);
      const progressToken = extra._meta?.progressToken;
      let root: string;
      try {
        root = await getRoot(server, requested);
      } catch (err) {
        if (err instanceof ReviewError) return errorResult(err.message);
        throw err;
      }
      const results: CheckResult[] = [];

      for (const [index, name] of checks.entries()) {
        if (extra.signal.aborted) break;
        results.push(await runCheck(name, root, extra.signal));
        if (progressToken !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: index + 1,
              total: checks.length,
              message: `${name}: ${results[results.length - 1]?.status}`
            }
          });
        }
      }

      const text = results
        .map((r) => `## ${r.name}: ${r.status}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}\n${r.output.trim()}`)
        .join('\n\n');
      // A failing check is a normal result for a reviewer, not a tool error.
      return textResult(text === '' ? 'No checks ran' : text, root);
    }
  );

  server.registerPrompt(
    'review_code',
    {
      title: 'Review code changes',
      description: 'Asks the model to review a branch using get_diff, read_file and run_checks.',
      argsSchema: {
        focus: completable(
          z.string().optional().describe(`One of: ${REVIEW_FOCUSES.join(', ')}. Defaults to all`),
          (typed) => REVIEW_FOCUSES.filter((f) => f.startsWith((typed ?? '').toLowerCase()))
        ),
        base: z.string().optional().describe("Base ref to compare against. Defaults to the repo's default branch (develop, main or master)"),
        head: z.string().optional().describe('Head ref to review. Defaults to HEAD'),
        root: z.string().optional().describe('Absolute path of the project to review. Defaults to your open workspace folder')
      }
    },
    async ({ focus: requestedFocus, base: requestedBase, head: requestedHead, root }) => {
      const focus = requestedFocus ?? 'all';
      const head = requestedHead ?? 'HEAD';
      let base = requestedBase;
      try {
        assertReviewAllowed();
      } catch (err) {
        if (err instanceof ReviewError) throw new McpError(ErrorCode.InvalidParams, err.message);
        throw err;
      }
      if (!REVIEW_FOCUSES.includes(focus)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown focus "${focus}". Known: ${REVIEW_FOCUSES.join(', ')}`);
      }
      if (!base) {
        // Best effort: when the project is not known yet, fall back to main.
        base = (await defaultBaseBranch(await getRoot(server, root).catch(() => process.cwd()))) ?? 'main';
      }
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Review the changes on ${head} since ${base}, focusing on ${focus}. ` +
                (root
                  ? `The project is at ${root}: pass root "${root}" on every tool call. `
                  : `Pass root as the absolute path of the project you are working in (your open workspace folder) on every tool call, so the right repo is reviewed. `) +
                `1. Call get_diff with base "${base}" and head "${head}". ` +
                `2. For anything unclear, call read_file to see the whole file. ` +
                `3. Call run_checks with ["build", "test"] and note any failure. ` +
                `Then list findings, most serious first. For each give the file, the line, what is wrong, and ` +
                `a concrete fix. Say plainly if you found nothing, and say what you could not verify.`
            }
          }
        ]
      };
    }
  );
}
