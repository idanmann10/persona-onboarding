import { connectionHandlers } from '@/lib/http/connections-runtime';
import { settleAfterRequest } from '@/lib/agent/background';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(request: Request) {
  if (!process.env.COMPOSIO_API_KEY) return new Response('Connections are not configured', { status: 503 });
  try {
    const response = await connectionHandlers().callback(request);
    // Connected or failed: the onboarding coach decides on a follow-up, after the response.
    await settleAfterRequest(request);
    return response;
  } catch (error) { console.error('Connection callback failed', error); return new Response('Connection service unavailable', { status: 503 }); }
}
