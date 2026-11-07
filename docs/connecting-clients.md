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

`PORT` (default `4768`) and `MCP_SESSION_TTL_MS` (idle timeout, default 30 minutes) also apply. The URL path is always `/mcp`; any other path returns 404.

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

- **`pnpm: command not found`**: nvm keeps global tools per Node version. Use a version that has pnpm (`nvm use 24.8.0`) or install it there with `npm install -g pnpm`. `nvm alias default 24.8.0` makes new terminals use it.
- **Port in use**: `lsof -nP -iTCP:4768 -sTCP:LISTEN` shows what holds the port.
- **Stateless mode forgets everything**: `set_home_location` followed by `get_home_weather` only works in stateful HTTP or stdio.
- **Debugging in VS Code**: `tsconfig.base.json` has `"sourceMap": true` so breakpoints in `.ts` files bind. Run `pnpm build` after changing code, because the debugger runs the build output.
