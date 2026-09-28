import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createGreetingHandler } from '@/lib/http/greeting';
import { turnDependencies } from '@/lib/agent/runtime';
import { openConversation } from '@/lib/agent/first-message';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  try {
    const store = createStore(getDatabase());
    return await createGreetingHandler(store, (sessionId) => openConversation(turnDependencies(store), sessionId))(request);
  } catch (error) {
    console.error('First message failed', error);
    return new Response('First message unavailable', { status: 503 });
  }
}
