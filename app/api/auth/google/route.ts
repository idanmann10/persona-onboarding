import { createGoogleStartHandler } from '@/lib/auth/sign-in';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Starts Google sign-in. The sign-in page's button links here. */
export async function GET(request: Request): Promise<Response> {
  return createGoogleStartHandler(process.env)(request);
}
