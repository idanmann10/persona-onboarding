import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createSignOutHandler } from '@/lib/auth/sign-out';
import { appBaseUrl } from '@/lib/auth/google';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const base = appBaseUrl(process.env);
  if (!base) return new Response('APP_BASE_URL is required', { status: 503 });
  try { return await createSignOutHandler(createStore(getDatabase()), base)(request); }
  catch (error) { console.error('Sign-out failed', error instanceof Error ? error.message : 'unknown error'); return new Response('Sign-out unavailable', { status: 503 }); }
}
