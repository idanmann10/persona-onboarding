import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createUpdatesHandler } from '@/lib/http/follow-up';
import { settleAfter } from '@/lib/agent/background';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** The page's light poll for follow-ups; `wake=1` also settles anything owed, in the background. */
export async function GET(request: Request): Promise<Response> {
  try {
    return await createUpdatesHandler(createStore(getDatabase()), settleAfter)(request);
  } catch (error) {
    console.error('Updates failed', error);
    return new Response('Updates unavailable', { status: 503 });
  }
}
