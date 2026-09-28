/**
 * Persona's cookies. All are HttpOnly, host-only and SameSite=Lax, and Secure whenever the app is served
 * over https. No cookie carries a conversation ID: the signed-in browser holds an opaque login token, and
 * the server looks up whose it is (see lib/auth/login.ts).
 */
/** The random login token of a signed-in browser. */
export const AUTH_COOKIE = 'persona_auth';
/** The OAuth state, PKCE verifier and nonce of a Google sign-in in progress, sent only to /api/auth/google. */
export const OAUTH_COOKIE = 'persona_oauth';
export const OAUTH_COOKIE_PATH = '/api/auth/google';
/** The guest conversation cookie from before sign-in existed. Nothing reads it; signing in or out clears it. */
export const LEGACY_SESSION_COOKIE = 'persona_session';

const LOGIN_MAX_AGE = 30 * 24 * 3600;
const OAUTH_MAX_AGE = 10 * 60;

export function isSecureRequest(request: Request, appBaseUrl?: string): boolean {
  return new URL(request.url).protocol === 'https:' || Boolean(appBaseUrl?.startsWith('https:'));
}

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of request.headers.get('cookie')?.split(';') ?? []) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || undefined;
  }
  return undefined;
}

function cookie(name: string, value: string, maxAge: number, secure: boolean, path = '/'): string {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export const loginCookie = (token: string, secure: boolean) => cookie(AUTH_COOKIE, token, LOGIN_MAX_AGE, secure);
export const clearedLoginCookie = (secure: boolean) => cookie(AUTH_COOKIE, '', 0, secure);
export const oauthCookie = (value: string, secure: boolean) => cookie(OAUTH_COOKIE, value, OAUTH_MAX_AGE, secure, OAUTH_COOKIE_PATH);
export const clearedOAuthCookie = (secure: boolean) => cookie(OAUTH_COOKIE, '', 0, secure, OAUTH_COOKIE_PATH);
export const clearedLegacySessionCookie = (secure: boolean) => cookie(LEGACY_SESSION_COOKIE, '', 0, secure);

/** How long a sign-in lasts before Google is asked again. */
export const LOGIN_DAYS = LOGIN_MAX_AGE / 86_400;
