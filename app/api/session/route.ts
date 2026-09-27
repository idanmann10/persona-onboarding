import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createSessionHandler } from '@/lib/http/session';
import { createDeleteSessionHandler } from '@/lib/http/delete-session';
import { createComposioClient } from '@/lib/integrations/composio';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    return await createSessionHandler(createStore(getDatabase()), process.env)(request);
  } catch (error) {
    console.error('Session initialization failed', error);
    return new Response('Session service unavailable', { status: 503 });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const appBaseUrl = process.env.APP_BASE_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000');
  if (!appBaseUrl) return new Response('APP_BASE_URL is required', { status: 503 });
  try { return await createDeleteSessionHandler(createStore(getDatabase()), createComposioClient(process.env.COMPOSIO_API_KEY || ''), appBaseUrl)(request); }
  catch (error) { console.error('Session deletion unavailable', error); return new Response('Session deletion unavailable', { status: 503 }); }
}
