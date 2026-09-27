import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createFollowUpHandler } from '@/lib/http/follow-up';
import { prepareTurn } from '@/lib/agent/turn';
import { generateTurn, turnDependencies } from '@/lib/agent/runtime';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_TEXT_MODEL) return new Response('Text model is not configured', { status: 503 });
  try {
    const store = createStore(getDatabase());
    const deps = turnDependencies(store);
    return await createFollowUpHandler(store, async (history, sessionId, trigger) =>
      generateTurn(await prepareTurn(deps, sessionId, history, { turnId: trigger.id, trigger })))(request);
  } catch (error) {
    console.error('Follow-up failed', error);
    return new Response('Follow-up unavailable', { status: 503 });
  }
}
