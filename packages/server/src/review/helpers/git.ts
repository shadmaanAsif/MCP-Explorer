import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ReviewError, truncate } from './errors.js';

export const execFileAsync = promisify(execFile);

const MAX_DIFF_BYTES = 100_000;

export async function gitToplevel(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim();
  } catch {
    return cwd;
  }
}

// The branch a review should compare against when the caller names none: the
// remote's default branch, else the first of develop/main/master that exists.
export async function defaultBaseBranch(root: string): Promise<string | undefined> {
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

export async function gitDiff(root: string, base: string, head: string, signal: AbortSignal): Promise<string> {
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
