import { Hono } from 'hono';

export const METADATA_PATH = '/.well-known/oauth-protected-resource';

// RFC 9728 protected resource metadata: tells a client which resource this is
// and which authorization server issues tokens for it. Public on purpose, a
// client reads it before it has a token.
export function resourceMetadataApp(resource: string, authorizationServer: string) {
  const app = new Hono();
  const document = {
    resource,
    authorization_servers: [authorizationServer],
    bearer_methods_supported: ['header']
  };
  // Root form and the path form for a resource at /mcp (RFC 9728 section 3.1).
  app.get(METADATA_PATH, (c) => c.json(document));
  app.get(`${METADATA_PATH}/mcp`, (c) => c.json(document));
  return app;
}
