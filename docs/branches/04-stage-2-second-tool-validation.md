# #4 — Stage 2: second tool and input validation (`04-stage-2-second-tool-validation`)

**Status:** merged into `main`.

## What it did

Added one more tool, `divide`, to show what validation looks like once "wrong type" is not the only way a call can be bad.

## Why `divide`

`add` only needed zod to describe a **shape**: two numbers, no further rules. `divide` needs a **rule** on top of the shape: `b` can be any number except zero. That is a business rule, not just a type.

```ts
b: z
  .number()
  .refine((value) => value !== 0, {
    message: 'b must not be zero — division by zero is undefined'
  })
  .describe('The denominator (must not be zero)')
```

`.refine()` layers a custom check on top of the base `z.number()` check, with its own error message. That message is what the caller sees.

## What happens on bad input

Calling `divide` with `a: 10, b: 0` never reaches the handler. The SDK validates the arguments against the schema first and returns:

```json
{
  "content": [{ "type": "text", "text": "MCP error -32602: Input validation error: Invalid arguments for tool divide: b must not be zero — division by zero is undefined at b" }],
  "isError": true
}
```

- **`isError: true`** is a tool-level error result. It is not a JSON-RPC protocol error and not a crash. The server keeps running and the client is told that this one call failed.
- The handler's `console.error('[mcp-demo] divide called...')` never prints for that call. Validation happens before your code sees the input, so you should not re-check `b !== 0` inside the handler.

## How to try it

Connect any client (see [connecting-clients.md](../connecting-clients.md)), then:
- `divide` with `a: 10, b: 2` returns `5`.
- `divide` with `a: 10, b: 0` is rejected with the message above.

The scripted client runs both: `pnpm start:http`, then `pnpm client`.
