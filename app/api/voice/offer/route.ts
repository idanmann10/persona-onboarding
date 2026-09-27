import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createCallOfferHandler } from '@/lib/http/call-offer';

export const runtime = 'nodejs';

export async function DELETE(request: Request): Promise<Response> {
  try { return await createCallOfferHandler(createStore(getDatabase()))(request); }
  catch (error) { console.error('Call offer update failed', error); return new Response('Call offer unavailable', { status: 503 }); }
}
