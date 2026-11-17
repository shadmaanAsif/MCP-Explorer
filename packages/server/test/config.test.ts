import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadConfigOrExit } from '../src/config.js';

const HTTP_ENTRY = fileURLToPath(new URL('../build/http.js', import.meta.url));

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
}

describe('loadConfig (Stage 10.5)', () => {
  it('gives the defaults for an empty environment', () => {
    expect(loadConfig({})).toEqual({
      port: 4768,
      mcpServerUrl: 'http://localhost:4768/mcp',
      issuerUrl: 'http://localhost:4769',
      mode: 'stateful',
      sessionTtlMs: 1_800_000,
      authRequired: false,
      authScope: 'mcp:tools',
      allowedOrigins: ['http://localhost:4767', 'http://127.0.0.1:4767'],
      maxBodyBytes: 1_048_576,
      ratePerMinute: 120
    });
  });

  it('reads values, derives the URL from the port, and treats an empty value as not set', () => {
    const c = loadConfig({ MCP_SERVER_PORT: '5000', MCP_SERVER_URL: '', ISSUER_URL: '', AUTH_REQUIRED: '1', ...{ ISSUER_URL: 'https://idp.test' } });
    expect(c.port).toBe(5000);
    expect(c.mcpServerUrl).toBe('http://localhost:5000/mcp');
    expect(c.authRequired).toBe(true);
    expect(c.issuerUrl).toBe('https://idp.test');
  });

  it('falls back to PORT when MCP_SERVER_PORT is not set', () => {
    expect(loadConfig({ PORT: '6001' }).port).toBe(6001);
    expect(loadConfig({ PORT: '6001', MCP_SERVER_PORT: '6002' }).port).toBe(6002);
  });

  it('names each bad variable', () => {
    const list = problems({
      MCP_SERVER_PORT: 'abc',
      MCP_MODE: 'both',
      AUTH_REQUIRED: 'true',
      MAX_BODY_BYTES: '0',
      RATE_LIMIT_PER_MINUTE: '-1',
      MCP_SERVER_URL: 'not a url',
      ALLOWED_ORIGINS: 'http://ok.test,ftp://nope'
    });
    for (const name of ['MCP_SERVER_PORT', 'MCP_MODE', 'AUTH_REQUIRED', 'MAX_BODY_BYTES', 'RATE_LIMIT_PER_MINUTE', 'MCP_SERVER_URL', 'ALLOWED_ORIGINS']) {
      expect(list.some((p) => p.startsWith(`${name}:`)), name).toBe(true);
    }
  });

  it('refuses a port out of range, and 0 for the body cap, but allows 0 for the rate limit', () => {
    expect(problems({ MCP_SERVER_PORT: '70000' })).toHaveLength(1);
    expect(problems({ MCP_SERVER_PORT: '0' })).toHaveLength(1);
    expect(problems({ RATE_LIMIT_PER_MINUTE: '0' })).toEqual([]);
  });

  it('needs ISSUER_URL when auth is on', () => {
    const list = problems({ AUTH_REQUIRED: '1' });
    expect(list).toEqual([expect.stringMatching(/^ISSUER_URL: is required when AUTH_REQUIRED=1/)]);
    expect(problems({ AUTH_REQUIRED: '1', ISSUER_URL: 'http://idp.test' })).toEqual([]);
  });

  it('refuses production with auth off', () => {
    expect(problems({ NODE_ENV: 'production' })).toEqual([expect.stringMatching(/^AUTH_REQUIRED: must be 1 when NODE_ENV=production/)]);
    expect(problems({ NODE_ENV: 'production', AUTH_REQUIRED: '1', ISSUER_URL: 'http://idp.test' })).toEqual([]);
    expect(problems({ NODE_ENV: 'development' })).toEqual([]);
  });

  it('never puts the bad value in the message', () => {
    const secret = 'hunter2-not-a-number';
    const e = (() => {
      try {
        loadConfig({ MCP_SERVER_PORT: secret });
      } catch (err) {
        return err as ConfigError;
      }
    })();
    expect(e).toBeInstanceOf(ConfigError);
    expect(e!.message).not.toContain(secret);
  });

  it('loadConfigOrExit rethrows anything that is not a ConfigError', () => {
    expect(() => loadConfigOrExit({ MCP_SERVER_PORT: '5000' })).not.toThrow();
  });
});

// The compiled server, started with a bad setting, must exit 1 with the message and no stack trace.
function runServer(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HTTP_ENTRY], {
      env: { ...process.env, MCP_SERVER_PORT: '', PORT: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.once('exit', (code) => resolve({ code, output }));
  });
}

describe('the compiled server refuses a bad config (Stage 10.5)', () => {
  it('exits 1 and names the variable for a bad port', async () => {
    const { code, output } = await runServer({ MCP_SERVER_PORT: 'abc' });
    expect(code).toBe(1);
    expect(output).toContain('Invalid configuration');
    expect(output).toContain('MCP_SERVER_PORT');
    expect(output).not.toContain('    at ');
  });

  it('exits 1 when auth is on and ISSUER_URL is missing', async () => {
    const { code, output } = await runServer({ AUTH_REQUIRED: '1', ISSUER_URL: '' });
    expect(code).toBe(1);
    expect(output).toContain('ISSUER_URL: is required when AUTH_REQUIRED=1');
  });

  it('exits 1 in production with auth off', async () => {
    const { code, output } = await runServer({ NODE_ENV: 'production', AUTH_REQUIRED: '0' });
    expect(code).toBe(1);
    expect(output).toContain('AUTH_REQUIRED: must be 1 when NODE_ENV=production');
  });
});
