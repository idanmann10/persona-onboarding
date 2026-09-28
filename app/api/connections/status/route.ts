import { connectionHandlers } from '@/lib/http/connections-runtime';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try { return await connectionHandlers().connected(request); }
  catch (error) { console.error('Connection status failed', error); return new Response('Connection service unavailable', { status: 503 }); }
}
