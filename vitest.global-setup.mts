import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The HTTP tests start the compiled server (build/http.js) as a child process,
// so make sure the build is current before any test runs. Without this, a test
// run after an edit would silently exercise the old build.
export default function setup() {
  const root = fileURLToPath(new URL('.', import.meta.url));
  execFileSync(process.execPath, [`${root}node_modules/typescript/bin/tsc`, '-p', `${root}packages/server`], {
    stdio: 'inherit'
  });
}
