import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_CHECK_OUTPUT_CHARS = 4000;
const DEFAULT_CHECK_TIMEOUT_MS = 120_000;

// The only things run_checks may run: `<package manager> run <script>` in the repo
// root, with the script name taken from the fixed list below. The package manager
// is the one the project itself uses (see detectPackageManager).
// The caller picks a name; it never supplies the command.
export const CHECKS = ['build', 'test', 'typecheck'] as const;
type CheckName = (typeof CHECKS)[number];

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

// Run the project's own package manager. Running pnpm in an npm project made
// pnpm install the dependencies itself and write a pnpm-lock.yaml into the
// reviewed repo, which broke it. Order: the `packageManager` field in
// package.json, then the lockfile. When both a package-lock.json and another
// lockfile exist, npm wins: a stray second lockfile is the usual cause.
export async function detectPackageManager(root: string, pkg: { packageManager?: unknown }): Promise<PackageManager> {
  if (typeof pkg.packageManager === 'string') {
    const name = pkg.packageManager.split('@')[0] as PackageManager;
    if (PACKAGE_MANAGERS.includes(name)) return name;
  }
  const lockfiles: [string, PackageManager][] = [
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun']
  ];
  for (const [file, manager] of lockfiles) {
    if (await fs.access(path.join(root, file)).then(() => true, () => false)) return manager;
  }
  return 'npm';
}

export async function readPackageJson(root: string): Promise<{ scripts?: Record<string, unknown>; packageManager?: unknown } | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function reviewTimeoutMs(): number {
  const parsed = Number(process.env.REVIEW_CHECK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHECK_TIMEOUT_MS;
}

// --- run_checks ------------------------------------------------------------------

export type CheckResult = {
  name: CheckName;
  status: 'passed' | 'failed' | 'skipped' | 'cancelled' | 'timed out';
  exitCode: number | null;
  output: string;
  command?: string;
};

export async function runCheck(
  name: CheckName,
  root: string,
  manager: PackageManager,
  callerSignal: AbortSignal
): Promise<CheckResult> {
  const command = `${manager} run ${name}`;
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
      // No shell, and only `<manager> run <known script>`: nothing from the
      // caller reaches the command line.
      // `detached` gives the package manager its own process group, so cancel
      // and timeout can kill the script it started too. Killing only the
      // manager leaves the script running.
      // pnpm 12 installs missing dependencies and writes a pnpm-lock.yaml before
      // it runs a script. A review must not change the project it reads, so turn
      // both off (checked on pnpm 12.8.1: neither setting is enough alone).
      const child = spawn(manager, ['run', name], {
        cwd: root,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', pnpm_config_lockfile: 'false' }
      });
      const stop = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        reject(new Error('stopped'));
      };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', reject);
      child.on('close', (code) => {
        signal.removeEventListener('abort', stop);
        resolve(code);
      });
    });
    return { name, status: exitCode === 0 ? 'passed' : 'failed', exitCode, output: output.slice(-MAX_CHECK_OUTPUT_CHARS), command };
  } catch (err) {
    if (callerSignal.aborted) return { name, status: 'cancelled', exitCode: null, output: output.slice(-MAX_CHECK_OUTPUT_CHARS), command };
    if (timedOut) return { name, status: 'timed out', exitCode: null, output: output.slice(-MAX_CHECK_OUTPUT_CHARS), command };
    return { name, status: 'failed', exitCode: null, output: `Could not start: ${(err as Error).message}`, command };
  } finally {
    clearTimeout(timer);
  }
}
