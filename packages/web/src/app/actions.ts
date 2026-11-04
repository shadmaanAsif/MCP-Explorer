'use server';

import { withClient } from '@/lib/mcp-client';
import { startCall, finishCall } from '@/lib/in-flight';

export type RunToolResult = {
  content: unknown;
  isError: boolean;
};

// Called directly from a Client Component's event handler, like a normal
// async function — not bound to a <form>, so it doesn't need the
// (prevState, formData) shape useActionState requires. Returns an explicit
// plain shape rather than the SDK's result object directly: that object has
// a `[x: string]: unknown` index signature, which widens named properties
// like `isError` to `unknown` once inferred back on the client side of the
// action boundary.
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  callId: string
): Promise<RunToolResult> {
  const controller = startCall(callId);
  try {
    return await withClient(async (client) => {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        signal: controller.signal
      });
      return { content: result.content, isError: result.isError === true };
    });
  } catch (err) {
    if (controller.signal.aborted) {
      return { content: [{ type: 'text', text: 'Cancelled' }], isError: true };
    }
    throw err;
  } finally {
    finishCall(callId);
  }
}
