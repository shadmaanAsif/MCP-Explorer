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

// --- Resources, prompts and completions ------------------------------------
// Plain read calls, so they go through withClient like runTool but need no
// cancel registry. Errors for a bad URI, prompt or argument are protocol
// errors (thrown by the SDK), so they are turned into a returned message here
// instead of crashing the page.
export type ReadResult = { ok: true; text: string } | { ok: false; message: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function readResource(uri: string): Promise<ReadResult> {
  try {
    const res = await withClient((client) => client.readResource({ uri }));
    const text = res.contents
      .map((c) => ('text' in c ? c.text : `[binary ${c.mimeType ?? 'data'}]`))
      .join('\n');
    return { ok: true, text };
  } catch (err) {
    return { ok: false, message: message(err) };
  }
}

export async function getPrompt(name: string, args: Record<string, string>): Promise<ReadResult> {
  try {
    const res = await withClient((client) => client.getPrompt({ name, arguments: args }));
    const text = res.messages
      .map((m) => `${m.role}: ${m.content.type === 'text' ? m.content.text : `[${m.content.type}]`}`)
      .join('\n\n');
    return { ok: true, text };
  } catch (err) {
    return { ok: false, message: message(err) };
  }
}

// Autocomplete for one argument. `ref` says whether the argument belongs to a
// prompt or to a resource template; failures just mean "no suggestions".
export async function completeArgument(
  ref: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string },
  argName: string,
  value: string
): Promise<string[]> {
  try {
    const res = await withClient((client) =>
      client.complete({ ref, argument: { name: argName, value } })
    );
    return res.completion.values;
  } catch {
    return [];
  }
}
