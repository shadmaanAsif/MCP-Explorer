import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileAsync } from './git.js';
import { ReviewError } from './errors.js';

const MAX_FILE_BYTES = 200_000;
const MAX_LISTED_FILES = 200;

// --- path guard ----------------------------------------------------------------

export function isInside(root: string, target: string): boolean {
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

export async function readRepoFile(root: string, relativePath: string): Promise<string> {
  const real = await resolveSafe(root, relativePath);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new ReviewError(`Not a file: ${relativePath}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new ReviewError(`File is too large (${stat.size} bytes, limit ${MAX_FILE_BYTES})`);
  }
  return fs.readFile(real, 'utf8');
}

export async function listRepoFiles(root: string): Promise<string[]> {
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
