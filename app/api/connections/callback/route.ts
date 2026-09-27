import { connectionHandlers } from '@/lib/http/connections-runtime';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (!process.env.COMPOSIO_API_KEY) return new Response('Connections are not configured', { status: 503 });
  try { return await connectionHandlers().callback(request); }
  catch (error) { console.error('Connection callback failed', error); return new Response('Connection service unavailable', { status: 503 }); }
}
