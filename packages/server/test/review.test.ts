import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { connectInMemory } from './helpers/connect.js';

// A throwaway git repo is the review root, so the tests never depend on this
// repository's own history or files.
let repo: string;
let outside: string;
type Connected = Awaited<ReturnType<typeof connectInMemory>>;
let c: Connected;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;

function setScripts(scripts: Record<string, string>) {
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', scripts }));
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'review-repo-'));
  outside = mkdtempSync(path.join(tmpdir(), 'review-outside-'));
  writeFileSync(path.join(outside, 'secret.txt'), 'top secret');

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src', 'a.txt'), 'line one\n');
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');

  git('checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(repo, 'src', 'a.txt'), 'line one\nfeature change\n');
  writeFileSync(path.join(repo, '.env.local'), 'API_KEY=hunter2\n');
  writeFileSync(path.join(repo, 'cert.pem'), 'PRIVATE');
  symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'link-out.txt'));
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');

  process.env.REVIEW_ROOT = repo;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  delete process.env.REVIEW_ROOT;
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

beforeEach(async () => {
  c = await connectInMemory();
});
afterEach(async () => {
  await c.close();
});

describe('get_diff', () => {
  it('returns the changes on head since base', async () => {
    const r = await c.client.callTool({ name: 'get_diff', arguments: { base: 'main', head: 'feature' } });
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toContain('+feature change');
  });

  it('keeps secret files out of the diff, even when they are committed', async () => {
    const text = textOf(await c.client.callTool({ name: 'get_diff', arguments: { base: 'main', head: 'feature' } }));
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('PRIVATE');
  });

  it('reports no differences for identical refs', async () => {
    const r = await c.client.callTool({ name: 'get_diff', arguments: { base: 'main', head: 'main' } });
    expect(textOf(r)).toBe('(no differences)');
  });

  it.each(['--output=/tmp/pwned', '-p', 'a..b', 'main;ls', 'ma in', '$(id)'])('rejects the ref %j', async (ref) => {
    for (const args of [
      { base: ref, head: 'feature' },
      { base: 'main', head: ref }
    ]) {
      const r = await c.client.callTool({ name: 'get_diff', arguments: args });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toMatch(/Invalid (base|head) ref/);
    }
  });

  it('returns an error result for a ref that does not exist', async () => {
    const r = await c.client.callTool({ name: 'get_diff', arguments: { base: 'main', head: 'no-such-branch' } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain('git diff failed');
  });

  it('did not create a file when handed an option-looking ref', () => {
    expect(existsSync('/tmp/pwned')).toBe(false);
  });
});

describe('read_file', () => {
  it('reads a file inside the repo', async () => {
    const r = await c.client.callTool({ name: 'read_file', arguments: { path: 'src/a.txt' } });
    expect(textOf(r)).toBe('line one\nfeature change\n');
  });

  it.each([
    ['a ../ path', '../sibling/secret.txt', 'outside the repo root'],
    ['an absolute path', '/etc/passwd', 'relative to the repo root'],
    ['a sneaky ../ in the middle', 'src/../../etc/passwd', 'outside the repo root'],
    ['a symlink that points outside', 'link-out.txt', 'outside the repo root'],
    ['an .env file', '.env.local', 'not allowed'],
    ['a private key', 'cert.pem', 'not allowed'],
    ['the .git directory', '.git/config', 'not allowed'],
    ['a missing file', 'nope.txt', 'File not found'],
    ['a directory', 'src', 'Not a file']
  ])('refuses %s', async (_label, p, message) => {
    const r = await c.client.callTool({ name: 'read_file', arguments: { path: p } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain(message);
  });

  it('refuses a file over the size limit', async () => {
    writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(200_001));
    try {
      const r = await c.client.callTool({ name: 'read_file', arguments: { path: 'big.txt' } });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toContain('too large');
    } finally {
      rmSync(path.join(repo, 'big.txt'));
    }
  });
});

describe('resource repo://file/{+path}', () => {
  it('lists tracked files and leaves the blocked ones out', async () => {
    const { resources } = await c.client.listResources();
    const uris = resources.map((x) => x.uri).filter((u) => u.startsWith('repo://file/'));
    expect(uris).toContain('repo://file/src/a.txt');
    expect(uris).toContain('repo://file/README.md');
    expect(uris).not.toContain('repo://file/.env.local');
    expect(uris).not.toContain('repo://file/cert.pem');
  });

  it('lists the template', async () => {
    const { resourceTemplates } = await c.client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain('repo://file/{+path}');
  });

  it('reads a file whose path contains a slash', async () => {
    const r = await c.client.readResource({ uri: 'repo://file/src/a.txt' });
    expect((r.contents[0] as { text: string }).text).toBe('line one\nfeature change\n');
  });

  it('fails with an invalid-params error for a blocked path', async () => {
    const err = await c.client.readResource({ uri: 'repo://file/.env.local' }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
  });

  it('fails for a path that tries to leave the repo', async () => {
    const err = await c.client.readResource({ uri: 'repo://file/..%2F..%2Fetc%2Fpasswd' }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
  });

  it('completes the path from the tracked files', async () => {
    const r = await c.client.complete({
      ref: { type: 'ref/resource', uri: 'repo://file/{+path}' },
      argument: { name: 'path', value: 'src/' }
    });
    expect(r.completion.values).toEqual(['src/a.txt']);
  });
});

describe('prompt review_code', () => {
  it('is listed with its arguments', async () => {
    const { prompts } = await c.client.listPrompts();
    const p = prompts.find((x) => x.name === 'review_code');
    expect(p?.arguments?.map((a) => a.name)).toEqual(['focus', 'base', 'head', 'root']);
  });

  it('names the tools and the refs it was given', async () => {
    const r = await c.client.getPrompt({
      name: 'review_code',
      arguments: { focus: 'security', base: 'main', head: 'feature' }
    });
    const text = (r.messages[0].content as { text: string }).text;
    expect(text).toContain('focusing on security');
    expect(text).toContain('get_diff');
    expect(text).toContain('base "main" and head "feature"');
    expect(text).toContain('run_checks');
  });

  it('uses main and HEAD when base and head are left out', async () => {
    const r = await c.client.getPrompt({ name: 'review_code', arguments: { focus: 'bugs' } });
    expect((r.messages[0].content as { text: string }).text).toContain('base "main" and head "HEAD"');
  });

  it('works with no arguments at all (clients that cannot send any)', async () => {
    const r = await c.client.getPrompt({ name: 'review_code' });
    const text = (r.messages[0].content as { text: string }).text;
    expect(text).toContain('focusing on all');
    expect(text).toContain('base "main" and head "HEAD"');
  });

  it('compares against the repo default branch when it is not main', async () => {
    git('branch', 'develop', 'main');
    try {
      const r = await c.client.getPrompt({ name: 'review_code' });
      expect((r.messages[0].content as { text: string }).text).toContain('base "develop" and head "HEAD"');
    } finally {
      git('branch', '-D', 'develop');
    }
  });

  it('rejects an unknown focus with invalid params', async () => {
    const err = await c.client.getPrompt({ name: 'review_code', arguments: { focus: 'vibes' } }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
  });

  it('completes the focus', async () => {
    const r = await c.client.complete({
      ref: { type: 'ref/prompt', name: 'review_code' },
      argument: { name: 'focus', value: 's' }
    });
    expect(r.completion.values).toEqual(['security', 'style']);
  });
});

describe('run_checks', () => {
  it('reports a passing and a failing check, in order', async () => {
    setScripts({ build: 'node -e "console.log(\'built ok\')"', test: 'node -e "console.error(\'boom\');process.exit(3)"' });
    const r = await c.client.callTool({ name: 'run_checks', arguments: { checks: ['build', 'test'] } });
    const text = textOf(r);
    expect(isError(r)).toBe(false); // a failing check is a result, not a tool error
    expect(text.indexOf('## build: passed')).toBeGreaterThanOrEqual(0);
    expect(text).toContain('built ok');
    expect(text.indexOf('## test: failed (exit 3)')).toBeGreaterThan(text.indexOf('## build'));
    expect(text).toContain('boom');
  });

  it('sends one progress update per check, only when asked', async () => {
    setScripts({ build: 'node -e "0"', test: 'node -e "0"' });
    const updates: { progress: number; total?: number; message?: string }[] = [];
    await c.client.callTool(
      { name: 'run_checks', arguments: { checks: ['build', 'test'] } },
      undefined,
      { onprogress: (p) => updates.push(p) }
    );
    expect(updates.map((u) => [u.progress, u.total])).toEqual([[1, 2], [2, 2]]);
    expect(updates[0].message).toBe('build: passed');
  });

  describe('package manager', () => {
    let project: string;
    beforeEach(() => {
      project = mkdtempSync(path.join(tmpdir(), 'review-pm-'));
      process.env.REVIEW_ROOT = project; // the server is pinned to one repo, so point it at this one
    });
    afterEach(() => {
      process.env.REVIEW_ROOT = repo;
      rmSync(project, { recursive: true, force: true });
    });

    const write = (name: string, body: unknown) =>
      writeFileSync(path.join(project, name), typeof body === 'string' ? body : JSON.stringify(body));
    const run = (checks: string[]) =>
      c.client.callTool({ name: 'run_checks', arguments: { checks } }).then(textOf);

    it('uses npm in a project with a package-lock.json, and leaves the project untouched', async () => {
      write('package.json', { name: 'p', scripts: { build: 'node -e "console.log(\'hi\')"' }, dependencies: { 'is-odd': '3.0.1' } });
      write('package-lock.json', '{}');
      const text = await run(['build']);
      expect(text).toContain('## build: passed');
      expect(text).toContain('$ npm run build');
      expect(existsSync(path.join(project, 'node_modules'))).toBe(false);
      expect(existsSync(path.join(project, 'pnpm-lock.yaml'))).toBe(false);
    });

    it('does not let pnpm install dependencies before running a script', async () => {
      write('package.json', {
        name: 'p',
        packageManager: 'pnpm@12.8.1',
        scripts: { build: 'node -e "0"' },
        dependencies: { 'is-odd': '3.0.1' }
      });
      const text = await run(['build']);
      expect(text).toContain('$ pnpm run build');
      expect(existsSync(path.join(project, 'node_modules'))).toBe(false);
      expect(existsSync(path.join(project, 'pnpm-lock.yaml'))).toBe(false);
    });

    it('skips a script the project does not have, and still runs the others', async () => {
      write('package.json', { name: 'p', scripts: { build: 'node -e "0"', test: 'node -e "0"' } });
      write('package-lock.json', '{}');
      const text = await run(['build', 'typecheck', 'test']);
      expect(text).toContain('## build: passed');
      expect(text).toContain('## typecheck: skipped');
      expect(text).toContain('no "typecheck" script');
      expect(text).toContain('## test: passed');
    });

    it('reports a project with no package.json as an error', async () => {
      const r = await c.client.callTool({ name: 'run_checks', arguments: { checks: ['build'] } });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toContain('No readable package.json');
    });
  });

  it('rejects a check name that is not on the list', async () => {
    const r = await c.client.callTool({ name: 'run_checks', arguments: { checks: ['rm -rf /'] } }).catch((e) => e);
    // Either a protocol error or an isError result, but never a run.
    expect(r instanceof Error || isError(r)).toBe(true);
  });

  it('times out a check that runs too long', async () => {
    process.env.REVIEW_CHECK_TIMEOUT_MS = '300';
    try {
      setScripts({ build: 'node -e "setTimeout(()=>{},30000)"' });
      const started = Date.now();
      const r = await c.client.callTool({ name: 'run_checks', arguments: { checks: ['build'] } });
      expect(textOf(r)).toContain('## build: timed out');
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      delete process.env.REVIEW_CHECK_TIMEOUT_MS;
    }
  });

  it('stops the running check when the client cancels', async () => {
    const pidFile = path.join(repo, 'pid.txt');
    rmSync(pidFile, { force: true });
    setScripts({
      build: `node -e "require('fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(()=>{}, 30000)"`
    });

    const controller = new AbortController();
    const started = Date.now();
    const call = c.client
      .callTool({ name: 'run_checks', arguments: { checks: ['build'] } }, undefined, { signal: controller.signal })
      .catch((e) => e);
    // Wait until the check is really running before cancelling.
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    controller.abort();
    await call;
    expect(Date.now() - started).toBeLessThan(10_000);

    // The check's own process must be gone, not just pnpm.
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});
