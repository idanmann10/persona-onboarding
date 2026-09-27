import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createSessionHandler } from '@/lib/http/session';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    return await createSessionHandler(createStore(getDatabase()))(request);
  } catch (error) {
    console.error('Session initialization failed', error);
    return new Response('Session service unavailable', { status: 503 });
  }
}
