import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createVoiceToolHandler } from '@/lib/http/voice-tool';
import { createComposioClient } from '@/lib/integrations/composio';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const composio = process.env.COMPOSIO_API_KEY ? createComposioClient(process.env.COMPOSIO_API_KEY) : undefined;
    return await createVoiceToolHandler(createStore(getDatabase()), process.env, composio)(request);
  } catch (error) {
    console.error('Voice tool failed', error);
    return new Response('Voice tool unavailable', { status: 503 });
  }
}
