/** The guest/main session cookie: HttpOnly, host-only, SameSite=Lax, Secure whenever the app is served over https. */
export const SESSION_COOKIE = 'persona_session';
const MAX_AGE = 30 * 24 * 3600;

export function isSecureRequest(request: Request, appBaseUrl?: string): boolean {
  return new URL(request.url).protocol === 'https:' || Boolean(appBaseUrl?.startsWith('https:'));
}

export function sessionCookie(sessionId: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
