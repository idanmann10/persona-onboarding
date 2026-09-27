import { createVoiceSessionHandler } from '@/lib/http/voice';
import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  if (!process.env.OPENAI_API_KEY) return new Response('Voice model is not configured', { status: 503 });
  try {
    return await createVoiceSessionHandler(createStore(getDatabase()), process.env.OPENAI_API_KEY, fetch, process.env)(request);
  } catch (error) {
    console.error('Voice session failed', error);
    return new Response('Voice service unavailable', { status: 503 });
  }
}
