import { clearedSessionCookie } from './cookie';

/**
 * Sign out of this browser: clears the session cookie and keeps every server-side record, so the person
 * can come back by connecting the same Gmail. A same-origin POST only, like every other state change.
 */
export function createSignOutHandler(appBaseUrl: string) {
  return async (request: Request): Promise<Response> => {
    const origin = new URL(appBaseUrl).origin;
    if (request.headers.get('origin') !== origin) return new Response('Origin mismatch', { status: 403 });
    const secure = origin.startsWith('https:') || new URL(request.url).protocol === 'https:';
    return new Response(null, { status: 204, headers: { 'Set-Cookie': clearedSessionCookie(secure), 'Cache-Control': 'no-store' } });
  };
}
