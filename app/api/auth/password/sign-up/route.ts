import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createPasswordSignUpHandler } from '@/lib/auth/password-sign-in';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try { return await createPasswordSignUpHandler(createStore(getDatabase()), process.env)(request); }
  catch (error) {
    console.error('Password sign-up failed', error instanceof Error ? error.message : 'unknown error');
    return Response.json({ error: 'Creating your account is unavailable right now. Please try again.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
