import { connectionHandlers } from '@/lib/http/connections-runtime';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try { return await connectionHandlers().decline(request); }
  catch (error) { console.error('Connection decline failed', error); return new Response('Connection service unavailable', { status: 503 }); }
}
