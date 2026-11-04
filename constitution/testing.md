# Testing / verifying a change

## Minimal checklist to actually test a change

1. `pnpm build` — after any edit, before trying to run anything. This builds both workspace packages (`packages/server` and `packages/client`).
2. Then either:
   - **MCP Inspector** (`pnpm dlx @modelcontextprotocol/inspector node packages/server/build/index.js`, run from the project root) — for interactive, click-driven testing. Each fresh Inspector run prints a new session token that has to be pasted into its Configuration panel before Connect will work.
   - **The custom client** (`pnpm client`) — a scripted, no-UI run of the exact same handshake. To try different input, edit the hardcoded `arguments` in `packages/client/src/client.ts` and rebuild — there's no interactive input.
3. Don't report a change as working from reading the code alone — actually run one of the above and look at the real output first.

## Verifying HTTP behaviour (stateful, cancel, idle sweep)

The Inspector over stdio can't show these. Use throwaway ports (not 4768, which may be a server you're using) and a stub upstream, and stop only the processes you started.

- **Failure paths in `get_weather`:** point `OPEN_METEO_URL` at a local stub that returns 500, 404, invalid JSON, a wrong shape, or never answers. A 5xx or a hang should show 3 upstream hits; a 404, bad JSON or wrong shape should show exactly 1.
- **Cancel reaches a running call:** run the server with `MCP_MODE=stateful` and a stub that accepts a request and never answers. Call `get_weather` from a script with `callTool(..., { signal })`, abort at 2s, and keep the client connected. The stub should see the connection close at about 2s with no retry. Repeat with `MCP_MODE=stateless`: it closes only at 8s (the server's own timeout) and a retry follows. Don't end the client process to "finish" the test — closing the connection also stops the handler and gives a false pass.
- **Idle sweep:** start with `MCP_SESSION_TTL_MS=4000`, connect one client and leave it idle, connect a second that keeps calling `listTools`. After about 12s the idle one should get a 404 and the busy one should still work; the server log shows the idle session closing.
- **Dashboard recovery:** restart the MCP server while the dashboard stays open, then click Run or reload the page. It should recover without restarting the web app. While the server is down the error is `fetch failed` (expected, not retried).
- **Debugging in VS Code:** set `"sourceMap": true` (already in `tsconfig.base.json`) and run `pnpm build` so breakpoints in `.ts` files bind. The debug terminal must use a Node version that has pnpm.
