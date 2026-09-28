import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createTestLoginHandler, testLoginEnabled } from '@/lib/auth/sign-in';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Local end-to-end tests only (see testLoginEnabled). Anywhere else this route answers 404. */
export async function GET(request: Request): Promise<Response> {
  if (!testLoginEnabled(process.env, request)) return new Response('Not found', { status: 404 });
  try {
    return await createTestLoginHandler(createStore(getDatabase()), process.env)(request);
  } catch (error) {
    console.error('Test login failed', error instanceof Error ? error.message : 'unknown error');
    return new Response('Test login unavailable', { status: 503 });
  }
}
