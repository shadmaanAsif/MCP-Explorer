import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_SERVER_URL = 'http://localhost:4768/mcp';

// Thrown when the server answers 401: it wants a token and we sent none, or the
// one we sent was refused. The message says what to do, so a caller sees more
// than a bare "401".
export class AuthRequiredError extends Error {
  constructor(
    message: string,
    readonly metadataUrl: string | undefined
  ) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

// Reads one key out of a WWW-Authenticate header, e.g. resource_metadata="...".
function headerParam(header: string, key: string): string | undefined {
  return header.match(new RegExp(`${key}="([^"]*)"`))?.[1];
}

// Wraps fetch so a 401 turns into an AuthRequiredError that names the metadata
// URL from the server's WWW-Authenticate header (9.3 sends it).
function authAwareFetch(hadToken: boolean): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (res.status !== 401) return res;
    const header = res.headers.get('www-authenticate') ?? '';
    const metadataUrl = headerParam(header, 'resource_metadata');
    const scope = headerParam(header, 'scope');
    const why = hadToken ? 'The server refused the token in MCP_TOKEN (wrong, expired or for another server).' : 'The server needs a token and MCP_TOKEN is not set.';
    throw new AuthRequiredError(
      `${why} Make one with "pnpm issuer token --sub <name>${scope ? ` --scope \\"${scope}\\"` : ''}" and set MCP_TOKEN.` +
        (metadataUrl ? ` Server metadata: ${metadataUrl}` : ''),
      metadataUrl
    );
  };
}

// Shared by both the CLI script (client.ts) and the web dashboard
// (packages/web) — anything that needs to talk to the server goes through
// this one connection setup instead of duplicating it.
//
// The server runs as its own process (pnpm start:http)
// and is reached over HTTP, so the client no longer spawns it or needs to
// know where its build output lives — just a URL. If the server has
// AUTH_REQUIRED=1, MCP_TOKEN holds the Bearer token sent on every request.
export async function connectToServer(
  url: string = process.env.MCP_SERVER_URL ?? DEFAULT_SERVER_URL,
  token: string | undefined = process.env.MCP_TOKEN || undefined
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    fetch: authAwareFetch(Boolean(token))
  });

  const client = new Client({
    name: 'mcp-demo-test-client',
    version: '0.1.0'
  });

  // connect() does the whole handshake: sends "initialize" to the server's
  // URL and waits for its reply.
  await client.connect(transport);
  return client;
}
