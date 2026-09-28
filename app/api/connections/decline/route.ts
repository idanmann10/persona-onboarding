import { connectionHandlers } from '@/lib/http/connections-runtime';
import { settleAfterRequest } from '@/lib/agent/background';

export const runtime = 'nodejs';

/** A Connect card's Not now; the assistant then carries on in the chat (lib/agent/follow-ups.ts). */
export async function POST(request: Request) {
  try {
    const response = await connectionHandlers().decline(request);
    if (response.ok) await settleAfterRequest(request);
    return response;
  } catch (error) { console.error('Connection decline failed', error); return new Response('Connection service unavailable', { status: 503 }); }
}
