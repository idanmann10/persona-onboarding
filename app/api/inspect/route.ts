import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createInspectHandler } from '@/lib/http/inspect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    return await createInspectHandler(createStore(getDatabase()), process.env)(request);
  } catch (error) {
    console.error('Agent log failed', error);
    return new Response('Agent log unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
