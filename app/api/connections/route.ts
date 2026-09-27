import { connectionHandlers } from '@/lib/http/connections-runtime';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try { return await connectionHandlers().status(request); }
  catch (error) { console.error('Connection status failed', error); return new Response('Connection service unavailable', { status: 503 }); }
}

export async function POST(request: Request) {
  if (!process.env.COMPOSIO_API_KEY) return new Response('Connections are not configured', { status: 503 });
  try { return await connectionHandlers().start(request); }
  catch (error) { console.error('Connection start failed', error); return new Response('Connection service unavailable', { status: 503 }); }
}

export async function DELETE(request: Request) {
  if (!process.env.COMPOSIO_API_KEY) return new Response('Connections are not configured', { status: 503 });
  try { return await connectionHandlers().disconnect(request); }
  catch (error) { console.error('Connection deletion failed', error); return new Response('Connection service unavailable', { status: 503 }); }
}
