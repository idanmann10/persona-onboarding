import { createVoiceEventHandler } from '@/lib/http/voice-events';
import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    return await createVoiceEventHandler(createStore(getDatabase()))(request);
  } catch (error) {
    console.error('Voice event failed', error);
    return new Response('Voice event service unavailable', { status: 503 });
  }
}
