import 'server-only';

// Tool calls currently running, keyed by an id the browser generates. The
// Cancel button reaches the server through a separate request (/api/cancel),
// which looks the call up here and aborts its controller. On globalThis for
// the same reason as the cached client: it survives dev-mode Fast Refresh.
const globalForCalls = globalThis as unknown as { inFlightCalls?: Map<string, AbortController> };
const calls = (globalForCalls.inFlightCalls ??= new Map<string, AbortController>());

export function startCall(callId: string): AbortController {
  const controller = new AbortController();
  calls.set(callId, controller);
  return controller;
}

export function finishCall(callId: string): void {
  calls.delete(callId);
}

export function cancelCall(callId: string): boolean {
  const controller = calls.get(callId);
  if (!controller) return false;
  controller.abort();
  return true;
}
