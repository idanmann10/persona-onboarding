import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createGoogleCallbackHandler } from '@/lib/auth/sign-in';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    return await createGoogleCallbackHandler(createStore(getDatabase()), process.env)(request);
  } catch (error) {
    console.error('Google sign-in callback failed', error instanceof Error ? error.message : 'unknown error');
    return new Response('Sign-in is unavailable right now. Please try again.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
