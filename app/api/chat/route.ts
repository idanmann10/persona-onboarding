import { after } from 'next/server';
import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createChatHandler } from '@/lib/http/chat';
import { prepareTurn } from '@/lib/agent/turn';
import { streamTurn, turnDependencies } from '@/lib/agent/runtime';
import { afterTurn } from '@/lib/agent/follow-ups';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_TEXT_MODEL) {
    return new Response('Text model is not configured', { status: 503 });
  }
  try {
    const store = createStore(getDatabase());
    const deps = turnDependencies(store);
    const handler = createChatHandler(store, async function* (history, sessionId) {
      const latestUser = history.filter((event) => event.type === 'message' && event.speaker === 'user').at(-1);
      const turn = await prepareTurn(deps, sessionId, history, { turnId: latestUser?.id ?? crypto.randomUUID() });
      yield* streamTurn(turn);
    // The coach and the memory run once the reply has streamed, so they never add latency.
    }, (sessionId, userEventId) => after(() => afterTurn(deps, sessionId, userEventId).catch((error) => console.error('After-turn agents failed', error))));
    return await handler(request);
  } catch (error) {
    console.error('Chat request failed', error);
    return new Response('Chat service unavailable', { status: 503 });
  }
}
