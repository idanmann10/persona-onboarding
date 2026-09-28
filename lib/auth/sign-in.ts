import type { AccountProfile } from '../db/store';
import {
  clearedLegacySessionCookie, clearedOAuthCookie, isSecureRequest, LOGIN_DAYS, loginCookie, OAUTH_COOKIE, oauthCookie, readCookie,
} from './cookie';
import {
  appBaseUrl, authorizationUrl, exchangeCode, googleConfig, GoogleSignInError, newPendingSignIn, parsePending, sameSecret, serializePending, verifyIdToken,
} from './google';
import { hashLoginToken, newLoginToken, openMainSession, readLoginToken, type LoginStore, type MainSessionStore } from './login';
import { locationFacts, profileFacts, recordFacts } from './profile';

export interface SignInStore extends LoginStore, MainSessionStore {
  upsertAccount(profile: AccountProfile): Promise<{ id: string; mainSessionId: string | null }>;
  createLogin(tokenHash: string, accountId: string, expiresAt: Date): Promise<void>;
  deleteLogin(tokenHash: string): Promise<void>;
}

type Env = Record<string, string | undefined>;

/** Reasons the sign-in page can explain. Only these codes ever go into its URL. */
export type SignInError = 'not_configured' | 'cancelled' | 'expired' | 'failed' | 'unverified' | 'busy';

function redirect(location: URL, cookies: string[]): Response {
  const headers = new Headers({ Location: location.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

/** Back to the sign-in page with a reason; the half-finished sign-in is forgotten. */
function failed(base: string, secure: boolean, error: SignInError): Response {
  const location = new URL('/sign-in', base);
  location.searchParams.set('error', error);
  return redirect(location, [clearedOAuthCookie(secure)]);
}

/**
 * Finishes any sign-in (Google, or the local test login): refreshes the account, opens its main
 * conversation, records what we learned about the user in it, and gives this browser a new login.
 */
export async function completeSignIn(store: SignInStore, request: Request, profile: AccountProfile, base: string): Promise<Response> {
  const secure = isSecureRequest(request, base);
  const account = await store.upsertAccount(profile);
  const user = { accountId: account.id, sessionId: account.mainSessionId, ...profile };
  const session = await openMainSession(store, user, request);
  if (session === 'limited') return failed(base, secure, 'busy');
  // A new conversation was just seeded; an existing one only learns what changed since last time.
  if (!session.created) await recordFacts(store, session.id, [...profileFacts(profile), ...locationFacts(request)], session.events, 'signin:profile');
  // Never reuse a login across sign-ins: this browser's previous token, if any, stops working.
  const previous = readLoginToken(request);
  if (previous) await store.deleteLogin(hashLoginToken(previous));
  const token = newLoginToken();
  await store.createLogin(hashLoginToken(token), account.id, new Date(Date.now() + LOGIN_DAYS * 86_400_000));
  return redirect(new URL('/', base), [loginCookie(token, secure), clearedOAuthCookie(secure), clearedLegacySessionCookie(secure)]);
}

/** GET /api/auth/google: remembers a fresh state, PKCE verifier and nonce in this browser, then goes to Google. */
export function createGoogleStartHandler(env: Env) {
  return async (request: Request): Promise<Response> => {
    const base = appBaseUrl(env);
    if (!base) return new Response('APP_BASE_URL is required', { status: 503 });
    const secure = isSecureRequest(request, base);
    const config = googleConfig(env);
    if (!config) return failed(base, secure, 'not_configured');
    const pending = newPendingSignIn();
    return redirect(new URL(authorizationUrl(config, pending)), [oauthCookie(serializePending(pending), secure)]);
  };
}

/**
 * GET /api/auth/google/callback: Google sends the browser back with a code. The state must match the one
 * this browser started with, the code is exchanged server-side with the PKCE verifier, and the ID token's
 * claims are checked before anyone is signed in.
 */
export function createGoogleCallbackHandler(store: SignInStore, env: Env, fetchFn: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    const base = appBaseUrl(env);
    if (!base) return new Response('APP_BASE_URL is required', { status: 503 });
    const secure = isSecureRequest(request, base);
    const config = googleConfig(env);
    if (!config) return failed(base, secure, 'not_configured');
    const params = new URL(request.url).searchParams;
    const error = params.get('error');
    if (error) return failed(base, secure, error === 'access_denied' ? 'cancelled' : 'failed');
    const pending = parsePending(readCookie(request, OAUTH_COOKIE));
    if (!pending) return failed(base, secure, 'expired');
    const code = params.get('code');
    const state = params.get('state');
    if (!code || code.length > 2_048 || !state || !sameSecret(state, pending.state)) return failed(base, secure, 'failed');
    let profile: AccountProfile;
    try {
      profile = verifyIdToken(await exchangeCode(config, code, pending.verifier, fetchFn), config, pending.nonce);
    } catch (cause) {
      const reason = cause instanceof GoogleSignInError ? cause.code : 'unexpected';
      console.error('Google sign-in failed', reason);
      return failed(base, secure, reason === 'unverified_email' ? 'unverified' : 'failed');
    }
    return completeSignIn(store, request, profile, base);
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The local end-to-end test login. On only when E2E_TEST_LOGIN=on, outside a production build, and for a
 * request addressed to this machine. `next build` fixes NODE_ENV to production, so no deployment can enable it.
 */
export function testLoginEnabled(env: Env, request?: Request): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (env.E2E_TEST_LOGIN !== 'on') return false;
  if (!request) return true;
  const hostOf = (value: string | null) => value?.split(',')[0]?.trim().replace(/:\d+$/, '').toLowerCase();
  const hosts = [new URL(request.url).hostname.toLowerCase(), hostOf(request.headers.get('host')), hostOf(request.headers.get('x-forwarded-host'))];
  return hosts.every((host) => host === undefined || host === '' || LOCAL_HOSTS.has(host));
}

/**
 * GET /api/auth/test-login[?user=name]: signs in a fake user without Google, for Playwright. Each `user`
 * is its own account; the same name on two browsers shares one conversation, as with Google.
 */
export function createTestLoginHandler(store: SignInStore, env: Env) {
  return async (request: Request): Promise<Response> => {
    if (!testLoginEnabled(env, request)) return new Response('Not found', { status: 404 });
    const url = new URL(request.url);
    // Back to the host the browser used (localhost or 127.0.0.1, checked above), where its cookie lives.
    const base = `${url.protocol}//${request.headers.get('host') ?? url.host}`;
    const name = url.searchParams.get('user') ?? 'tester';
    if (!/^[a-z0-9-]{1,32}$/.test(name)) return new Response('user must be 1-32 lowercase letters, digits or dashes', { status: 400 });
    const given = `${name[0].toUpperCase()}${name.slice(1)}`;
    return completeSignIn(store, request, { sub: `e2e-${name}`, email: `${name}@e2e.persona.test`, fullName: `${given} Test`, givenName: given, locale: 'en' }, base);
  };
}
