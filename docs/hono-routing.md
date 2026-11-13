# Hono routing: `use`, `get`, `all`, `route`

How the Hono methods in `packages/server/src/http.ts` differ. Each one registers a rule: "for requests like this, run this function".

## 1. The methods

| Method | Matches | Ends the request? |
|---|---|---|
| `app.get(path, handler)` | only `GET` | Yes, the handler returns the response |
| `app.post`, `app.put`, `app.delete` | only that HTTP method | Yes |
| `app.all(path, handler)` | every HTTP method | Yes |
| `app.on(methods, path, handler)` | the methods you list, or custom ones | Yes |
| `app.use(path, middleware)` | every method, on a path prefix or `'*'` | No. It calls `await next()` to carry on, or returns a response to stop |
| `app.route(path, subApp)` | mounts another Hono app under `path` | Depends on the sub-app's own rules |

## 2. Handlers and middleware

- **Handlers** (`get`, `post`, `all`…) produce the answer: `(c) => c.json(...)`.
- **Middleware** (`use`) runs before the handler. It can inspect or change the request, then either:
  - call `await next()` to pass the request along, or
  - return a response, which stops the chain. Our token and scope guards refuse requests this way.

## 3. Order matters

Hono runs matching rules in the order they were registered. The first one to return a response wins.

## 4. Example

```ts
import { Hono } from 'hono';
const app = new Hono();

// use on every path: middleware, calls next() to carry on
app.use('*', async (c, next) => {
  console.log(c.req.method, c.req.path);
  await next();
});

// use on a prefix: a guard, returns a response to stop
app.use('/admin/*', async (c, next) => {
  if (c.req.header('Authorization') !== 'Bearer secret') return c.text('No', 401);
  await next();
});

app.get('/hello', (c) => c.text('Hi'));                                  // GET only
app.post('/items', async (c) => c.json({ saved: await c.req.json() }, 201)); // POST only
app.all('/echo', (c) => c.text(`You sent ${c.req.method}`));             // any method
app.on(['PUT', 'PATCH'], '/items/:id', (c) => c.text(`updated ${c.req.param('id')}`));

// route: mount another app under a prefix
const users = new Hono();
users.get('/', (c) => c.text('all users'));
users.get('/:id', (c) => c.text(`user ${c.req.param('id')}`));
app.route('/users', users);
```

| Request | Result |
|---|---|
| `GET /hello` | logger runs, then `Hi` |
| `POST /hello` | logger runs, no rule matches, `404` |
| `POST /items` with `{"a":1}` | `201 {"saved":{"a":1}}` |
| `DELETE /echo` | `You sent DELETE` |
| `PATCH /items/7` | `updated 7` |
| `GET /users/3` | `user 3`, from the mounted sub-app |
| `GET /admin/stats`, no header | the guard returns `401`, the handler never runs |
| `GET /admin/stats`, with the header | the guard calls `next()` |

## 5. `app.route` is not a redirect

`app.route('/users', users)` does not send the client anywhere. The sub-app's rules are mounted under the `/users` prefix and answered in the same process.

- **Same request, same URL:** `GET /users/3` gets its response directly. There is no `302` and no second request.
- **One server:** `users` doesn't listen on a port. Only the main app is passed to `serve({ fetch: app.fetch, port })`.
- **Equivalent to writing the prefix yourself:**
  ```ts
  app.get('/users', (c) => c.text('all users'));
  app.get('/users/:id', (c) => c.text(`user ${c.req.param('id')}`));
  ```
  Without the `/users` prefix those lines would answer `/` and `/3` instead.
- **Middleware scope:** `users.use('*', auth)` on the sub-app applies only to the `/users…` routes. On the main app you would write `app.use('/users/*', auth)`.
- **A real redirect** is `app.get('/old', (c) => c.redirect('/new'))`. That sends a `302` and the client makes a second request.

## 6. Where this project uses each

In `packages/server/src/http.ts`:
- `app.use('*', …)`: runs on every request.
- `app.route('/', resourceMetadataApp(…))`: mounts the two public `/.well-known/oauth-protected-resource…` routes. It comes before the guards, so those routes stay open.
- `app.use(MCP_PATH, bearerAuth(…))` and `scopeGuard(…)`: the token and scope checks, only in front of `/mcp`. They stop the request with `401` or `403`, or call `next()`.
- `app.all(MCP_PATH, …)`: the real handler. It uses `all` because MCP over HTTP uses `POST` (messages), `GET` (the event stream) and `DELETE` (closing a session).

In `auth/resource-metadata.ts` and `auth/issuer.ts`, `app.get` serves the read-only notice and key routes.

## 7. Rule of thumb

- Data for one method: `get`, `post`…
- Same handler for any method: `all`.
- A check or step before the handler: `use`.
- Grouping routes from another file: `route`.
