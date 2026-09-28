import { createVoiceEventHandler } from '@/lib/http/voice-events';
import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { settleAfter } from '@/lib/agent/background';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  try {
    // A call that ended wakes the onboarding coach, after the response.
    return await createVoiceEventHandler(createStore(getDatabase()), settleAfter)(request);
  } catch (error) {
    console.error('Voice event failed', error);
    return new Response('Voice event service unavailable', { status: 503 });
  }
}
