# Testing / verifying a change

## Minimal checklist to actually test a change

1. `npm run build` — after any edit, before trying to run anything.
2. Then either:
   - **MCP Inspector** (`npx @modelcontextprotocol/inspector node build/index.js`, run from the project root) — for interactive, click-driven testing. Each fresh Inspector run prints a new session token that has to be pasted into its Configuration panel before Connect will work.
   - **The custom client** (`npm run client`) — a scripted, no-UI run of the exact same handshake. To try different input, edit the hardcoded `arguments` in `src/client.ts` and rebuild — there's no interactive input.
3. Don't report a change as working from reading the code alone — actually run one of the above and look at the real output first.
