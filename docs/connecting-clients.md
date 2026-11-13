# Connecting a client to the server

The server never does anything on its own. A **client** connects, asks what is available, and sends calls. This page covers every client used in this project and how each one reaches the server. Each branch file in [`branches/`](branches/) links here and says what to try once connected.

## 1. Pick a transport

The same server definition ([`create-server.ts`](../packages/server/src/create-server.ts)) runs two ways:

| | stdio | Streamable HTTP |
|---|---|---|
| Entry file | [`index.ts`](../packages/server/src/index.ts) | [`http.ts`](../packages/server/src/http.ts) |
| Who starts the server | The client spawns it as a child process | You start it: `pnpm start:http` |
| What you give the client | A command and arguments | A URL: `http://localhost:4768/mcp` |
| Instances | One new process per connection | One process serving every client |
| Needs the server running first | No (only a build) | Yes |
| Server logs appear | Inside the client (it captures stderr) | In the terminal running `pnpm start:http` |

Both need a build first, because the clients run compiled JavaScript:

```bash
pnpm install
pnpm build
```

HTTP mode has two sub-modes, chosen with `MCP_MODE`:
- `stateful` (default): one `McpServer` per client, keyed by the `Mcp-Session-Id` header. Remembers per-client state and delivers a client's cancel to a running call.
- `stateless`: a fresh `McpServer` per request. Remembers nothing.

`MCP_SERVER_PORT` (default `4768`; `PORT` still works as a fallback) and `MCP_SESSION_TTL_MS` (idle timeout, default 30 minutes) also apply. All ports and settings live in one file: see [Ports and settings](#ports-and-settings) at the end of this page. The URL path is always `/mcp`; any other path returns 404.

## 2. Scripted CLI client (`pnpm client`)

```bash
pnpm start:http     # terminal 1
pnpm client         # terminal 2
```

It connects to `MCP_SERVER_URL` (default `http://localhost:4768/mcp`), lists the tools and calls each one.

## 3. Web dashboard

```bash
pnpm start:http     # terminal 1
pnpm web            # terminal 2: production build, http://localhost:4767
```

`pnpm web:dev` runs it with hot reload. The dashboard builds a form from each tool's schema. Array and object arguments (such as `locations`) take JSON text.

## 4. MCP Inspector

A web UI where you click the buttons that an AI would otherwise decide to press.

**stdio**: the Inspector starts its own copy of the server:
```bash
pnpm build
pnpm dlx @modelcontextprotocol/inspector node packages/server/build/index.js
```
It prints a URL containing `MCP_PROXY_AUTH_TOKEN=<token>`. Open that exact URL (or paste the token into the Configuration panel's *Proxy Session Token*). Check that Command is `node` and Arguments is `packages/server/build/index.js`, then click **Connect**.

**Streamable HTTP**: start the server yourself, then start the Inspector without a command:
```bash
pnpm start:http
pnpm dlx @modelcontextprotocol/inspector
```
Set *Transport Type* to `Streamable HTTP` and *URL* to `http://localhost:4768/mcp`, then **Connect**. (Not run end to end in this project; the labels may differ slightly between Inspector versions.)

## 5. Cursor

[Cursor](https://cursor.com/) is an MCP client with a model behind it. Add the server in `~/.cursor/mcp.json` (or Cursor Settings → MCP).

**stdio** (Cursor launches the server, so only a build is needed):
```json
{
  "mcpServers": {
    "mcp-demo": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/MCP-Explorer/packages/server/build/index.js"]
    }
  }
}
```

**Streamable HTTP** (start `pnpm start:http` first):
```json
{
  "mcpServers": {
    "mcp-demo-http": {
      "url": "http://localhost:4768/mcp"
    }
  }
}
```

Reload Cursor's MCP servers afterwards. Tools appear for the assistant to call on its own. Prompts appear in the chat's `/` menu; with the HTTP entry above they showed up as `/user-mcp-demo-http/weather_report` and `/user-mcp-demo-http/compare_weather` (Cursor adds a `user-` prefix to the name).

Asking the model in words whether a prompt exists does not work: the model is given tools, while prompts and resources are surfaced to the user through the UI.

## 6. Claude Code

Not tested in this project, so treat these as the expected shape and check `claude mcp add --help`:
```bash
claude mcp add --transport http mcp-demo http://localhost:4768/mcp
```
`/mcp` lists connected servers. MCP prompts are expected to appear as slash commands named `/mcp__<server>__<prompt>`.

## 7. After you change the server

Neither transport reloads by itself.

1. `pnpm build`
2. HTTP only: stop `pnpm start:http` (Ctrl+C) and start it again. The running process keeps the old code in memory.
3. Reconnect the client: toggle the server off and on in Cursor or the Inspector, then re-list tools, prompts and resources, because clients cache those lists.

The web dashboard reconnects by itself after a server restart (it drops its stale session on a 404 and starts a new one).

## 8. Gotchas

- **`pnpm: command not found`**: nvm keeps global tools per Node version. Switch this terminal to a version that has pnpm (`nvm use 24.22.2`, the version CI uses) or install it for your current version with `npm install -g pnpm`. `nvm use` only affects the current terminal and leaves your default Node version unchanged.
- **Port in use**: `lsof -nP -iTCP:4768 -sTCP:LISTEN` shows what holds the port.
- **Stateless mode forgets everything**: `set_home_location` followed by `get_home_weather` only works in stateful HTTP or stdio.
- **Debugging in VS Code**: `tsconfig.base.json` has `"sourceMap": true` so breakpoints in `.ts` files bind. Run `pnpm build` after changing code, because the debugger runs the build output.

## 9. Using the code review server (Stage 8)

**The review tools work over stdio only.** `get_diff`, `read_file`, `run_checks`, the `review_code` prompt and the `repo://file/…` resource read the disk of the machine the server runs on. Over stdio that is your own machine. Over HTTP it is wherever the server runs, so they refuse there. Details: [docs/branches/16-stage-8-code-review.md](branches/16-stage-8-code-review.md).

### Use stdio, one server per project

1. **Get the code and build it** on your machine (once, and after every change):
   ```bash
   pnpm install
   pnpm build
   ```
2. **Add the server to the project's own `.cursor/mcp.json`:**
   ```json
   {
     "mcpServers": {
       "mcp-demo-review": {
         "command": "node",
         "args": ["/absolute/path/to/MCP-Explorer/packages/server/build/index.js"],
         "env": { "REVIEW_ROOT": "/absolute/path/to/this/project" }
       }
     }
   }
   ```
   Use the real absolute path of the project to review. Cursor may replace `${workspaceFolder}`, but that is unconfirmed. Without `REVIEW_ROOT` the server reviews the folder Cursor starts it in, which may not be your project.
3. **Turn it on:** toggle `mcp-demo-review` on in Cursor's MCP settings. Cursor starts the server itself, so don't run `pnpm start:http`.
4. **Use it:** type `/` and pick `review_code` with no arguments: it reviews your current branch against the repo's default branch (`develop`, `main` or `master`) with focus `all`. Cursor cannot pass arguments from chat; to change the focus or base, ask the model in plain words.
5. **After a rebuild:** toggle the server off and on.

Every result ends with a `[repo: /path]` line. Check it before trusting a review.

### How the server finds the project

`getRoot` in [`review/helpers/roots.ts`](../packages/server/src/review/helpers/roots.ts) picks the project in this order:

1. **`REVIEW_ROOT`**: if set, it always wins. In `mcp.json` this is the `env` block, **not** `args`. `args` holds only the command's arguments (the path to `build/index.js`).
2. **The tool's `root` argument**: passed by the model at call time, not read from `mcp.json`. It is refused when `REVIEW_ROOT` pins a different path.
3. **Client roots**: the server asks the client which folders are open. This only works if the client supports roots. Cursor's support is unconfirmed.
4. **The start folder**: the folder the server process was started in (`process.cwd()`, resolved to the git top level).

If none applies and `REVIEW_REQUIRE_ROOT=1` (the HTTP default), the call fails.

**How `env` reaches a stdio server:** the client starts the server as a child process, so it controls that process's environment.
1. Cursor reads `mcp.json` and runs the `command` with the `args`.
2. It adds the values in `env` to the child process's environment, the same as `REVIEW_ROOT=/path node build/index.js` in a shell.
3. The server reads it as `process.env.REVIEW_ROOT`. Nothing is sent over the MCP connection for this.

The variable is read once, at startup, so after editing `env` toggle the server off and on. Over HTTP the server is already running before any client connects, so a client's `mcp.json` can't set its environment. HTTP needs the `root` argument or the server's own settings instead.

### Over HTTP it will not work

If your client uses the `url` entry (`mcp-demo-http`), a review tool returns this error:

> Code review tools are not available over HTTP: they read the disk of the machine the server runs on, not your project. Use the stdio server on your own machine (docs/connecting-clients.md, section 9). If you want them to run on this server, ask the server admin to set REVIEW_ALLOW_HTTP=1 and REVIEW_ALLOWED_ROOTS and restart it.

The prompt and the resource fail with the same message. The weather tools, other resources and prompts work normally. If you need the review tools on a shared server, ask the person who runs it. They can start it with:
```bash
REVIEW_ALLOW_HTTP=1 REVIEW_ALLOWED_ROOTS=/Users/you/projects pnpm start:http
```
That only helps when the server runs on the same machine as the project. A server on another machine can't see your files, so a path like `/Users/you/project` still won't exist there.

### Limits

`run_checks` runs the project's `build`, `test` and `typecheck` scripts with the project's own package manager (npm, pnpm, yarn or bun, chosen from `packageManager` in `package.json`, then the lockfile). A script the project doesn't have is reported as `skipped`, and each result shows the command that ran. It runs the scripts as you, so they can write build output, but pnpm is stopped from installing dependencies or writing a lockfile into the project. None of this was tested in Cursor end to end.

## 10. Using tokens (Stage 9)

Over HTTP the server can require a token on every request to `/mcp`. It is off by default, so nothing above changes until you turn it on. stdio is never guarded.

1. **Turn it on.** In `packages/server/.env` set `AUTH_REQUIRED=1`, then restart `pnpm start:http`.
2. **Start the issuer** in its own tab: `pnpm issuer serve`. The server fetches the public key from it, so it must be running while auth is on (if it is down, `/mcp` answers `503`).
3. **Make a token** and keep it in a variable:
   ```bash
   export MCP_TOKEN=$(pnpm --silent issuer token --sub alice --scope "mcp:tools weather:use")
   ```
   `--ttl` sets the lifetime in seconds (default one hour). There is no refresh: when it expires, make a new one.
4. **Give it to the client.**
   - **CLI client:** `MCP_TOKEN=... pnpm client`, or put `MCP_TOKEN` in `packages/client/.env`.
   - **Dashboard:** put `MCP_TOKEN` in `packages/web/.env` and restart it. The token stays on the server side.
   - **Inspector or another client:** send the header `Authorization: Bearer <token>`.
5. **Check it.** With no token, the call is refused:
   ```bash
   curl -i -X POST localhost:4768/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{}'
   ```
   Expect `401` and a `WWW-Authenticate` header that holds the metadata address.

| What you send | Answer |
|---|---|
| No token | `401`, with `resource_metadata` and `scope` in `WWW-Authenticate` |
| Malformed `Authorization` header | `400` |
| Wrong key, expired, or made for another server | `401` |
| Valid token | works; the token is checked on every request, not once per session |
| Issuer down | `503` |

The CLI and the dashboard print a clear message on `401` that says whether the token was missing or refused. The `/.well-known/oauth-protected-resource` routes are public, so a client can find the issuer before it has a token.

For the full walk-through (three tabs, expected output at each step) and how to use a token from Cursor, the Inspector or Claude Code, see [Stage 9: try it end to end](branches/17-stage-9-authentication.md#try-it-end-to-end).

## Ports and settings

Each package has its own `.env`, with a committed `.env.example` next to it. Copy the templates once:

```bash
for p in server client web; do cp packages/$p/.env.example packages/$p/.env; done   # .env is git-ignored; the template values are the defaults
```

| Process | Command | File | Variable | Default |
|---|---|---|---|---|
| MCP server (HTTP) | `pnpm start:http` | `packages/server/.env` | `MCP_SERVER_PORT` | 4768 |
| Token issuer | `pnpm issuer serve` | `packages/server/.env` | `ISSUER_PORT` | 4769 |
| Web dashboard | `pnpm web`, `pnpm web:dev` | `packages/web/.env` | `WEB_PORT` | 4767 |
| CLI client | `pnpm client` | `packages/client/.env` | none (it connects out, to `MCP_SERVER_URL`) | |

`MCP_SERVER_URL` appears in all three files, and the server and issuer also share `ISSUER_URL`. If you change `MCP_SERVER_PORT`, update `MCP_SERVER_URL` in all three and `TOKEN_AUDIENCE` in the server file. Changing `ISSUER_PORT` changes the default for `ISSUER_URL` too, if `ISSUER_URL` is not set.

- **How each loads its file:** the server, issuer and client run `node --env-file-if-exists=.env`, since Node never reads `.env` by itself. The dashboard reads its own file through Next.js, plus a small wrapper (`scripts/next.mjs`) for `WEB_PORT`.
- **Which commands read a `.env`:** `start:http`, `issuer`, `client`, `web` and `web:dev`. The stdio server (`pnpm start`) does not, because Cursor or the Inspector start it and pass their own `env` in `mcp.json`.
- **Precedence:** a variable already set in your shell beats the file, and a command-line flag (such as `--ttl`) beats both. No `.env` at all also works.
- **Tests:** they pick free ports themselves and do not read `.env`.
