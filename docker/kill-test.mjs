// Stage 11.4: the kill test. Needs the stack from compose.scale.yml running.
//   0. get a token from the issuer service (auth is on)
//   1. open a session through the proxy and set a home location
//   2. find which instance holds the session; make sure the other one starts cold
//      (no live copy of the session), then stop the owner
//   3. call get_home_weather with the same session id through the proxy; the other
//      instance must rebuild the session from Redis after the owner died
//   4. a made-up session id must still be 404
// Plain Node (fetch + docker CLI), no dependencies.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROXY = process.env.PROXY_URL ?? 'http://localhost:4790/mcp';
const COMPOSE = fileURLToPath(new URL('./compose.scale.yml', import.meta.url));
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

const compose = (...args) => execFileSync('docker', ['compose', '-f', COMPOSE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const logsOf = (service) => compose('logs', '--no-color', '--no-log-prefix', service);
const count = (text, needle) => text.split(needle).length - 1;
// How many times a service has started listening, and how often it rebuilt this session.
const listening = (service) => count(logsOf(service), 'server running on');
const rebuilds = (service, id) => count(logsOf(service), `session ${id} rebuilt from the store`);
// After a start or restart, wait until the service is listening again.
async function waitListening(service, before) {
  for (let i = 0; i < 60 && listening(service) === before; i++) await new Promise((r) => setTimeout(r, 500));
}

// Auth is on, so every request needs a token. The issuer service signs one for "alice".
const ISSUER_CLI = 'packages/server/build/auth/issuer-cli.js';
async function mintToken() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return compose('exec', '-T', 'issuer', 'node', ISSUER_CLI, 'token', '--sub', 'alice', '--scope', 'mcp:tools weather:use').trim();
    } catch {
      /* the issuer is not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('could not get a token from the issuer service; is the stack up? (docker compose -f docker/compose.scale.yml up -d)');
}
const TOKEN = await mintToken();

let failed = false;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed = true;
};

// The answer to a POST is an SSE stream; the reply is its last `data:` line.
function reply(text) {
  const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  if (data.length) return JSON.parse(data[data.length - 1]);
  try {
    return JSON.parse(text); // errors such as a 404 come back as plain JSON
  } catch {
    return undefined;
  }
}

async function post(body, sessionId) {
  const headers = { ...HEADERS, Authorization: `Bearer ${TOKEN}` };
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
    headers['Mcp-Protocol-Version'] = '2025-11-25';
  }
  const res = await fetch(PROXY, { method: 'POST', headers, body: JSON.stringify(body) });
  return { res, message: reply(await res.text()) };
}

// Redis and the instances may still be starting.
async function initialize() {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'kill-test', version: '0' } }
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const { res } = await post(body);
      const id = res.headers.get('mcp-session-id');
      if (res.ok && id) return id;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no answer from ${PROXY}; is the stack up? (docker compose -f docker/compose.scale.yml up -d)`);
}

const sessionId = await initialize();
await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
console.log(`session ${sessionId} opened through the proxy`);

const set = await post(
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'set_home_location', arguments: { name: 'Dubai', latitude: 25.2, longitude: 55.27 } } },
  sessionId
);
check(set.message?.result?.isError !== true, 'set_home_location', set.message?.result?.content?.[0]?.text);

// Which instance created the session? Its log says "session <id> opened".
const owner = ['server-a', 'server-b'].find((s) => logsOf(s).includes(`session ${sessionId} opened`));
check(owner !== undefined, 'found the instance that holds the session', owner);
if (!owner) process.exit(1);
const survivor = owner === 'server-a' ? 'server-b' : 'server-a';

// The proxy alternates between instances, so the survivor may already have built its own
// live copy of the session. Then the failover would not need Redis at all. Restart it to
// drop that copy (the stored record stays), so the kill tests a rebuild from the record.
if (rebuilds(survivor, sessionId) > 0) {
  console.log(`${survivor} already holds a live copy of the session; restarting it so it starts cold ...`);
  const before = listening(survivor);
  compose('restart', survivor);
  await waitListening(survivor, before);
}
const rebuildsBefore = rebuilds(survivor, sessionId);

console.log(`stopping ${owner} ...`);
compose('stop', owner);

try {
  const home = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_home_weather', arguments: {} } }, sessionId);
  const text = home.message?.result?.content?.[0]?.text ?? JSON.stringify(home.message) ?? '';
  check(home.res.status === 200 && !text.includes('No home location'), `same session id still works after ${owner} died`, `HTTP ${home.res.status}`);
  check(text.startsWith('Dubai'), 'the home location survived', text.split('\n')[0]);
  check(rebuilds(survivor, sessionId) > rebuildsBefore, `${survivor} rebuilt the session from Redis after ${owner} died`);

  const fake = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_home_weather', arguments: {} } }, '00000000-0000-4000-8000-000000000000');
  check(fake.res.status === 404, 'a made-up session id is still 404', `HTTP ${fake.res.status}`);
} finally {
  console.log(`starting ${owner} again ...`);
  const before = listening(owner);
  compose('start', owner);
  // Leave the stack ready for the next run. The owner must be listening again, and
  // nginx skips a server for 5 s after a failed attempt (max_fails=1 fail_timeout=5s
  // in proxy.conf). Without the wait, a run started right away that stops the other
  // instance finds no usable one and gets a 502.
  await waitListening(owner, before);
  await new Promise((r) => setTimeout(r, 6000));
}

console.log(failed ? '\nKILL TEST FAILED' : '\nKILL TEST PASSED');
process.exit(failed ? 1 : 0);
