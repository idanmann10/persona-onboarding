import { createSignOutHandler } from '@/lib/auth/sign-out';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const appBaseUrl = process.env.APP_BASE_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000');
  if (!appBaseUrl) return new Response('APP_BASE_URL is required', { status: 503 });
  return createSignOutHandler(appBaseUrl)(request);
}
