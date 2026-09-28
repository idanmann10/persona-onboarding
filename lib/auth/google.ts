import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Profile } from './profile';

/**
 * Google sign-in: the OAuth 2.0 authorization-code flow with PKCE, state and an OpenID nonce, asking only
 * for `openid email profile`. Gmail and Calendar are never requested here; they stay separate, optional
 * Composio connections the user makes later in the conversation.
 */
export const GOOGLE_SCOPES = 'openid email profile';
export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
/** Tolerated clock difference with Google when checking token times. */
const SKEW_SECONDS = 120;

export interface GoogleConfig { clientId: string; clientSecret: string; redirectUri: string }

/** The app's public origin; localhost:3000 in development when APP_BASE_URL is unset. */
export function appBaseUrl(env: Record<string, string | undefined>): string | undefined {
  return env.APP_BASE_URL || (process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:3000');
}

/** Undefined until GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and the app's base URL are all set. */
export function googleConfig(env: Record<string, string | undefined>): GoogleConfig | undefined {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const base = appBaseUrl(env);
  if (!clientId || !clientSecret || !base) return undefined;
  return { clientId, clientSecret, redirectUri: new URL(GOOGLE_CALLBACK_PATH, base).toString() };
}

/** A sign-in in progress, kept in this browser's short-lived OAuth cookie. */
export interface PendingSignIn { state: string; verifier: string; nonce: string }

const random = (bytes: number) => randomBytes(bytes).toString('base64url');
const PENDING = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/;

export function newPendingSignIn(): PendingSignIn {
  return { state: random(32), verifier: random(32), nonce: random(16) };
}
export const serializePending = (pending: PendingSignIn) => `${pending.state}.${pending.verifier}.${pending.nonce}`;
export function parsePending(value: string | undefined): PendingSignIn | undefined {
  const match = value ? PENDING.exec(value) : null;
  return match ? { state: match[1], verifier: match[2], nonce: match[3] } : undefined;
}

export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Google's consent page for this sign-in (S256 PKCE). */
export function authorizationUrl(config: GoogleConfig, pending: PendingSignIn): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

/** Why a sign-in failed, as a code that is safe to log and to put in the sign-in page's URL. */
export class GoogleSignInError extends Error {
  constructor(readonly code: 'exchange_failed' | 'invalid_token' | 'unverified_email') { super(`Google sign-in failed: ${code}`); }
}

/** Trades the authorization code for Google's ID token, server to server. Tokens are never logged. */
export async function exchangeCode(config: GoogleConfig, code: string, verifier: string, fetchFn: typeof fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri,
        grant_type: 'authorization_code', code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new GoogleSignInError('exchange_failed'); }
  const body = await response.json().catch(() => undefined) as { id_token?: unknown; error?: unknown } | undefined;
  if (!response.ok || typeof body?.id_token !== 'string') {
    console.error('Google token exchange rejected', response.status, typeof body?.error === 'string' ? body.error.slice(0, 60) : '');
    throw new GoogleSignInError('exchange_failed');
  }
  return body.id_token;
}

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return clean && clean.length <= max ? clean : undefined;
};

function pictureUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com')) ? url.toString() : undefined;
  } catch { return undefined; }
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/;

/**
 * Checks the ID token's claims and returns the verified profile. The token came straight from Google's
 * token endpoint over TLS in exchange for our client secret, so, as OpenID Connect Core 3.1.3.7 allows and
 * Google's own guidance says, TLS stands in for checking its signature; the claims are all still checked.
 */
export function verifyIdToken(idToken: string, config: GoogleConfig, nonce: string, now = Date.now()): Profile & { sub: string } {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new GoogleSignInError('invalid_token');
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>; }
  catch { throw new GoogleSignInError('invalid_token'); }
  const seconds = now / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss) ||
      !audiences.includes(config.clientId) || ((claims.azp !== undefined || audiences.length > 1) && claims.azp !== config.clientId) ||
      typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < seconds ||
      typeof claims.iat !== 'number' || claims.iat - SKEW_SECONDS > seconds ||
      typeof claims.nonce !== 'string' || !sameSecret(claims.nonce, nonce) ||
      typeof claims.sub !== 'string' || !/^[\w-]{1,255}$/.test(claims.sub)) {
    throw new GoogleSignInError('invalid_token');
  }
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || email.length > 320 || !EMAIL.test(email)) throw new GoogleSignInError('invalid_token');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new GoogleSignInError('unverified_email');
  const locale = typeof claims.locale === 'string' && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/.test(claims.locale) ? claims.locale : undefined;
  const fullName = text(claims.name, 200);
  const givenName = text(claims.given_name, 100);
  const picture = pictureUrl(claims.picture);
  return { sub: claims.sub, email, ...(fullName ? { fullName } : {}), ...(givenName ? { givenName } : {}), ...(picture ? { picture } : {}), ...(locale ? { locale } : {}) };
}
