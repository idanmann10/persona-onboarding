import { timingSafeEqual } from 'node:crypto';
import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { summarizeFunnel } from '@/lib/domain/funnel';

export const runtime = 'nodejs';

const matches = (given: string, expected: string) => given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));

/** GET /api/admin/funnel?limit=500 with `Authorization: Bearer $ADMIN_SECRET`: the funnel over recent sessions. */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.ADMIN_SECRET;
  const given = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!secret || secret.length < 16 || !matches(given, secret)) return new Response('Not found', { status: 404 });
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get('limit')) || 500, 1), 5_000);
  try {
    const sessions = await createStore(getDatabase()).recentSessions(limit);
    return Response.json(summarizeFunnel(sessions.map((session) => session.events)), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Funnel query failed', error);
    return new Response('Funnel unavailable', { status: 503 });
  }
}
