import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createCallOfferHandler } from '@/lib/http/call-offer';
import { settleAfterRequest } from '@/lib/agent/background';

export const runtime = 'nodejs';

/** The call card's Not now; the assistant then carries on in the chat (lib/agent/follow-ups.ts). */
export async function DELETE(request: Request): Promise<Response> {
  try {
    const response = await createCallOfferHandler(createStore(getDatabase()))(request);
    if (response.ok) await settleAfterRequest(request);
    return response;
  } catch (error) { console.error('Call offer update failed', error); return new Response('Call offer unavailable', { status: 503 }); }
}
