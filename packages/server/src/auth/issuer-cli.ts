// Command line for the local token issuer.
//
//   node build/auth/issuer-cli.js serve
//   node build/auth/issuer-cli.js token --sub alice --scope "mcp:tools" [--aud URL] [--ttl 3600]
import { serve } from '@hono/node-server';
import { parseArgs } from 'node:util';
import {
  DEFAULT_KEY_FILE,
  createToken,
  issuerApp,
  loadOrCreateKeys,
} from './issuer.js';

// Every default can come from the environment (see .env.example); a flag wins.
const env = process.env;
const DEFAULT_AUDIENCE = env.TOKEN_AUDIENCE ?? 'http://localhost:4768/mcp';
const DEFAULT_PORT = env.ISSUER_PORT ?? '4769';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    sub: { type: 'string', default: 'demo-user' },
    scope: { type: 'string', default: '' },
    aud: { type: 'string', default: DEFAULT_AUDIENCE },
    ttl: { type: 'string', default: env.TOKEN_TTL_SECONDS ?? '3600' },
    issuer: { type: 'string', default: env.ISSUER_URL ?? `http://localhost:${DEFAULT_PORT}` },
    'key-file': { type: 'string', default: env.ISSUER_KEY_FILE ?? DEFAULT_KEY_FILE },
    port: { type: 'string', default: DEFAULT_PORT },
  },
});

const keys = await loadOrCreateKeys(values['key-file']);

if (command === 'token') {
  const ttlSeconds = Number(values.ttl);
  if (!Number.isFinite(ttlSeconds)) {
    console.error('--ttl must be a number of seconds');
    process.exit(1);
  }
  // The token goes to stdout alone so it can be used as $(...) in a shell.
  console.log(
    await createToken(keys, {
      issuer: values.issuer,
      subject: values.sub,
      audience: values.aud,
      scope: values.scope,
      ttlSeconds,
    }),
  );
} else if (command === 'serve') {
  const port = Number(values.port);
  serve({ fetch: issuerApp(keys, values.issuer).fetch, port }, () => {
    console.error(`Token issuer on ${values.issuer} (keys: ${values['key-file']}). Ctrl+C to stop.`);
  });
} else {
  console.error('Usage: issuer-cli.js serve | token [--sub NAME] [--scope "a b"] [--aud URL] [--ttl SECONDS]');
  process.exit(1);
}
