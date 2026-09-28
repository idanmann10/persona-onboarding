import { after } from 'next/server';
import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createUpdatesHandler } from '@/lib/http/follow-up';
import { turnDependencies } from '@/lib/agent/runtime';
import { reconcile } from '@/lib/agent/follow-ups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** The page's light poll for follow-ups; `wake=1` also settles anything owed, in the background. */
export async function GET(request: Request): Promise<Response> {
  try {
    const store = createStore(getDatabase());
    const configured = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_TEXT_MODEL);
    return await createUpdatesHandler(store, (sessionId) => {
      if (configured) after(() => reconcile(turnDependencies(store), sessionId).catch((error) => console.error('Follow-ups failed', error)));
    })(request);
  } catch (error) {
    console.error('Updates failed', error);
    return new Response('Updates unavailable', { status: 503 });
  }
}
