import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/create-server.js';

// Two throwaway repos stand in for "the project the client has open" (A) and
// "somewhere else" (B). Each has one file the other lacks, so a read tells us
// which repo the server chose.
let repoA: string;
let repoB: string;
let notARepo: string;

const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;

function makeRepo(prefix: string, file: string, script: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(dir, file), `${prefix}\n`);
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: prefix, scripts: { test: `echo ${script}` } })
  );
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return dir;
}

beforeAll(() => {
  repoA = makeRepo('roots-a-', 'only-in-a.txt', 'ran-in-a');
  repoB = makeRepo('roots-b-', 'only-in-b.txt', 'ran-in-b');
  notARepo = realpathSync(mkdtempSync(path.join(tmpdir(), 'roots-plain-')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const dir of [repoA, repoB, notARepo]) rmSync(dir, { recursive: true, force: true });
});

let close: (() => Promise<void>) | undefined;
beforeEach(() => {
  delete process.env.REVIEW_ROOT;
  delete process.env.REVIEW_ALLOWED_ROOTS;
});
afterEach(async () => {
  await close?.();
  close = undefined;
  delete process.env.REVIEW_ROOT;
  delete process.env.REVIEW_ALLOWED_ROOTS;
});

// `roots` undefined = a client that does not declare the roots capability.
async function connect(roots?: string[]) {
  const server = createServer();
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities: roots ? { roots: {} } : {} }
  );
  if (roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: roots.map((dir) => ({ uri: pathToFileURL(dir).href }))
    }));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  close = async () => {
    await client.close();
    await server.close();
  };
  return client;
}

const read = (client: Client, file: string) => client.callTool({ name: 'read_file', arguments: { path: file } });

describe('review root from the client', () => {
  it('uses the root the client declares', async () => {
    const client = await connect([repoB]);
    const found = await read(client, 'only-in-b.txt');
    expect(isError(found)).toBe(false);
    expect(textOf(found)).toContain('roots-b-');
    expect(isError(await read(client, 'only-in-a.txt'))).toBe(true);
  });

  it('follows the client, so two clients can review two different repos', async () => {
    const a = await connect([repoA]);
    expect(textOf(await read(a, 'only-in-a.txt'))).toContain('roots-a-');
    await close?.();
    const b = await connect([repoB]);
    expect(textOf(await read(b, 'only-in-b.txt'))).toContain('roots-b-');
  });

  it('resolves a subfolder root to the repo it belongs to', async () => {
    const client = await connect([path.join(repoB, 'sub')]);
    expect(isError(await read(client, 'only-in-b.txt'))).toBe(false);
  });

  it('uses the first root that exists', async () => {
    const client = await connect([path.join(tmpdir(), 'does-not-exist-xyz'), repoB]);
    expect(isError(await read(client, 'only-in-b.txt'))).toBe(false);
  });

  it('uses a root that is not a git repo as the folder itself', async () => {
    writeFileSync(path.join(notARepo, 'plain.txt'), 'plain\n');
    const client = await connect([notARepo]);
    expect(textOf(await read(client, 'plain.txt'))).toContain('plain');
  });

  it('run_checks runs in the client root, not the server folder', async () => {
    const client = await connect([repoB]);
    const r = await client.callTool({ name: 'run_checks', arguments: { checks: ['test'] } });
    expect(textOf(r)).toContain('ran-in-b');
    expect(textOf(r)).not.toContain('ran-in-a');
  });

  it('serves the resource and its list from the client root', async () => {
    const client = await connect([repoB]);
    const listed = await client.listResources();
    expect(listed.resources.map((r) => r.uri)).toContain('repo://file/only-in-b.txt');
    const res = await client.readResource({ uri: 'repo://file/only-in-b.txt' });
    expect((res.contents[0] as { text: string }).text).toContain('roots-b-');
  });
});

describe('review root precedence and fallback', () => {
  it('REVIEW_ROOT beats the client root', async () => {
    process.env.REVIEW_ROOT = repoA;
    const client = await connect([repoB]);
    expect(isError(await read(client, 'only-in-a.txt'))).toBe(false);
    expect(isError(await read(client, 'only-in-b.txt'))).toBe(true);
  });

  it('ignores the client roots when the client does not declare the capability', async () => {
    const client = await connect(undefined);
    // Falls back to the server's own folder, which is neither fixture repo.
    expect(isError(await read(client, 'only-in-a.txt'))).toBe(true);
    expect(isError(await read(client, 'only-in-b.txt'))).toBe(true);
  });

  it('ignores a client root outside REVIEW_ALLOWED_ROOTS', async () => {
    process.env.REVIEW_ALLOWED_ROOTS = repoA;
    const client = await connect([repoB]);
    expect(isError(await read(client, 'only-in-b.txt'))).toBe(true);
  });

  it('accepts a client root inside REVIEW_ALLOWED_ROOTS', async () => {
    process.env.REVIEW_ALLOWED_ROOTS = `${repoA}:${repoB}`;
    const client = await connect([repoB]);
    expect(isError(await read(client, 'only-in-b.txt'))).toBe(false);
  });

  it('still refuses paths outside the client root', async () => {
    const client = await connect([repoB]);
    expect(isError(await read(client, '../' + path.basename(repoA) + '/only-in-a.txt'))).toBe(true);
  });
});

// --- explicit `root` argument (the model passes the project path) ---------------

const withRoot = (client: Client, name: string, args: Record<string, unknown>, root?: string) =>
  client.callTool({ name, arguments: root === undefined ? args : { ...args, root } });
const usedRepo = (result: unknown) =>
  (result as { content: { text: string }[] }).content.map((c) => c.text).find((t) => t.startsWith('[repo: '));

describe('root argument', () => {
  it('reviews the repo named by the argument, with no client roots and no REVIEW_ROOT', async () => {
    const client = await connect(undefined);
    const r = await withRoot(client, 'read_file', { path: 'only-in-b.txt' }, repoB);
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toContain('roots-b-');
  });

  it('one shared server serves different repos on consecutive calls', async () => {
    const client = await connect(undefined);
    expect(textOf(await withRoot(client, 'read_file', { path: 'only-in-a.txt' }, repoA))).toContain('roots-a-');
    expect(textOf(await withRoot(client, 'read_file', { path: 'only-in-b.txt' }, repoB))).toContain('roots-b-');
  });

  it('names the repo it used in every result', async () => {
    const client = await connect(undefined);
    const file = await withRoot(client, 'read_file', { path: 'only-in-b.txt' }, repoB);
    expect(usedRepo(file)).toBe(`[repo: ${repoB}]`);
    const diff = await withRoot(client, 'get_diff', { base: 'main', head: 'main' }, repoA);
    expect(usedRepo(diff)).toBe(`[repo: ${repoA}]`);
  });

  it('run_checks runs in the repo named by the argument', async () => {
    const client = await connect(undefined);
    const r = await withRoot(client, 'run_checks', { checks: ['test'] }, repoA);
    expect(textOf(r)).toContain('ran-in-a');
    expect(usedRepo(r)).toBe(`[repo: ${repoA}]`);
  });

  it('beats the roots the client declares', async () => {
    const client = await connect([repoA]);
    const r = await withRoot(client, 'read_file', { path: 'only-in-b.txt' }, repoB);
    expect(textOf(r)).toContain('roots-b-');
  });

  it('resolves a subfolder to its repo', async () => {
    const client = await connect(undefined);
    const r = await withRoot(client, 'read_file', { path: 'only-in-b.txt' }, path.join(repoB, 'sub'));
    expect(usedRepo(r)).toBe(`[repo: ${repoB}]`);
  });

  it('rejects a relative path instead of guessing', async () => {
    const client = await connect(undefined);
    const r = await withRoot(client, 'read_file', { path: 'only-in-b.txt' }, 'relative/dir');
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain('absolute');
  });

  it('rejects a folder that does not exist instead of falling back to another repo', async () => {
    const client = await connect([repoA]);
    const r = await withRoot(client, 'read_file', { path: 'only-in-a.txt' }, path.join(tmpdir(), 'nope-xyz'));
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain('does not exist');
  });

  it('rejects a root outside REVIEW_ALLOWED_ROOTS', async () => {
    process.env.REVIEW_ALLOWED_ROOTS = repoA;
    const client = await connect(undefined);
    const r = await withRoot(client, 'read_file', { path: 'only-in-b.txt' }, repoB);
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain('REVIEW_ALLOWED_ROOTS');
  });

  it('rejects a root on run_checks and starts nothing', async () => {
    process.env.REVIEW_ALLOWED_ROOTS = repoA;
    const client = await connect(undefined);
    const r = await withRoot(client, 'run_checks', { checks: ['test'] }, repoB);
    expect(isError(r)).toBe(true);
    expect(textOf(r)).not.toContain('ran-in-b');
  });

  it('refuses a different repo when REVIEW_ROOT pins the server', async () => {
    process.env.REVIEW_ROOT = repoA;
    const client = await connect(undefined);
    const r = await withRoot(client, 'read_file', { path: 'only-in-b.txt' }, repoB);
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain('pinned');
  });

  it('accepts the pinned repo itself as the argument', async () => {
    process.env.REVIEW_ROOT = repoA;
    const client = await connect(undefined);
    const r = await withRoot(client, 'read_file', { path: 'only-in-a.txt' }, repoA);
    expect(isError(r)).toBe(false);
  });

  it('still refuses a path that escapes the named root', async () => {
    const client = await connect(undefined);
    const r = await withRoot(client, 'read_file', { path: `../${path.basename(repoA)}/only-in-a.txt` }, repoB);
    expect(isError(r)).toBe(true);
  });

  it('the review_code prompt tells the model to pass the project path', async () => {
    const client = await connect(undefined);
    const generic = await client.getPrompt({ name: 'review_code', arguments: { focus: 'bugs' } });
    expect((generic.messages[0].content as { text: string }).text).toContain('Pass root as the absolute path');
    const named = await client.getPrompt({ name: 'review_code', arguments: { focus: 'bugs', root: repoB } });
    expect((named.messages[0].content as { text: string }).text).toContain(`pass root "${repoB}" on every tool call`);
  });
});

// --- REVIEW_REQUIRE_ROOT: a shared server must not guess the repo -----------------

describe('REVIEW_REQUIRE_ROOT', () => {
  beforeEach(() => {
    process.env.REVIEW_REQUIRE_ROOT = '1';
  });
  afterEach(() => {
    delete process.env.REVIEW_REQUIRE_ROOT;
  });

  it('fails instead of falling back to the server folder', async () => {
    const client = await connect(undefined);
    const r = await read(client, 'package.json');
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain('Pass `root`');
  });

  it('fails for every review tool, and starts no process', async () => {
    const client = await connect(undefined);
    for (const [name, args] of [
      ['get_diff', { base: 'main' }],
      ['run_checks', { checks: ['test'] }]
    ] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect(isError(r), name).toBe(true);
      expect(textOf(r), name).toContain('Pass `root`');
    }
  });

  it('works when the call names a root', async () => {
    const client = await connect(undefined);
    expect(isError(await withRoot(client, 'read_file', { path: 'only-in-b.txt' }, repoB))).toBe(false);
  });

  it('works when the client declares a root', async () => {
    const client = await connect([repoB]);
    expect(isError(await read(client, 'only-in-b.txt'))).toBe(false);
  });

  it('works when REVIEW_ROOT pins the repo', async () => {
    process.env.REVIEW_ROOT = repoA;
    const client = await connect(undefined);
    expect(isError(await read(client, 'only-in-a.txt'))).toBe(false);
  });

  it('lists no resources, and reading one is a clear error', async () => {
    const client = await connect(undefined);
    const listed = await client.listResources();
    expect(listed.resources.filter((r) => r.uri.startsWith('repo://'))).toEqual([]);
    await expect(client.readResource({ uri: 'repo://file/package.json' })).rejects.toThrow(/Pass `root`/);
  });

  it('is off unless set, so stdio keeps the start-folder fallback', async () => {
    delete process.env.REVIEW_REQUIRE_ROOT;
    const client = await connect(undefined);
    expect(isError(await read(client, 'package.json'))).toBe(false);
  });
});
