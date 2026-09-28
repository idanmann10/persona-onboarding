import { clearedLegacySessionCookie, clearedLoginCookie, isSecureRequest } from './cookie';
import { hashLoginToken, readLoginToken } from './login';

interface Store { deleteLogin(tokenHash: string): Promise<void> }

/**
 * Sign out of this browser: its login stops working on the server and its cookie is cleared. The
 * conversation and connected accounts stay; signing in with the same Google account brings them back.
 * A same-origin POST only, like every other state change.
 */
export function createSignOutHandler(store: Store, appBaseUrl: string) {
  return async (request: Request): Promise<Response> => {
    const origin = new URL(appBaseUrl).origin;
    if (request.headers.get('origin') !== origin) return new Response('Origin mismatch', { status: 403 });
    const secure = isSecureRequest(request, appBaseUrl);
    const token = readLoginToken(request);
    // This browser is signed out even if the database can't be reached right now; the token is gone from it.
    if (token) {
      try { await store.deleteLogin(hashLoginToken(token)); }
      catch (error) { console.error('Sign-out could not revoke the login', error instanceof Error ? error.message : 'unknown error'); }
    }
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', clearedLoginCookie(secure));
    headers.append('Set-Cookie', clearedLegacySessionCookie(secure));
    return new Response(null, { status: 204, headers });
  };
}
