import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CHECKS, detectPackageManager, readPackageJson, runCheck, type CheckResult } from './helpers/checks.js';
import { ReviewError } from './helpers/errors.js';
import { readRepoFile } from './helpers/files.js';
import { defaultBaseBranch, gitDiff } from './helpers/git.js';
import { assertReviewAllowed, getRoot, listFilesOrNone } from './helpers/roots.js';

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

const REVIEW_FOCUSES = ['all', 'bugs', 'security', 'style', 'tests'];

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
        'Runs named checks (build / test / typecheck) with the project\'s own package manager (npm, pnpm, yarn or bun, from its lockfile), one after another, and reports progress after each. A script the project does not have is skipped. Cancel stops the running check.',
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
      const pkg = await readPackageJson(root);
      if (!pkg) return errorResult(`No readable package.json in ${root}, so there are no scripts to run.`);
      const manager = await detectPackageManager(root, pkg);

      for (const [index, name] of checks.entries()) {
        if (extra.signal.aborted) break;
        if (typeof pkg.scripts?.[name] !== 'string') {
          results.push({ name, status: 'skipped', exitCode: null, output: `package.json has no "${name}" script.` });
        } else {
          results.push(await runCheck(name, root, manager, extra.signal));
        }
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
        .map((r) => `## ${r.name}: ${r.status}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}${r.command ? `\n$ ${r.command}` : ''}\n${r.output.trim()}`)
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
