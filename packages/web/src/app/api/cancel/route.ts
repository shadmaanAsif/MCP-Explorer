import { cancelCall } from '@/lib/in-flight';

// A route handler, not a Server Action: Next.js runs Server Actions from the
// browser one at a time, so a cancel sent as an action would wait behind the
// very call it is meant to stop.
export async function POST(request: Request) {
  const { callId } = (await request.json()) as { callId?: string };
  if (!callId) return Response.json({ error: 'callId is required' }, { status: 400 });
  return Response.json({ cancelled: cancelCall(callId) });
}
