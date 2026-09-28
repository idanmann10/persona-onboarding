import type { PasswordAccount } from '../db/store';
import { IP_LIMITS, withinIpLimit } from '../http/client-key';
import { isSecureRequest } from './cookie';
import { appBaseUrl } from './google';
import { cleanName, emailLimitKey, hashPassword, MAX_PASSWORD, MIN_PASSWORD, normalizeEmail, spendPasswordCheck, verifyPassword } from './password';
import { beginLogin, type SignInStore } from './sign-in';

/**
 * Email + password accounts, next to Google. The same login cookie and one-account-one-conversation
 * model; the email is only typed, never verified, so it is a tentative fact and never matches a Google
 * account or the old Gmail sign-in's conversations.
 */
export interface PasswordStore extends SignInStore {
  createPasswordAccount(account: { email: string; passwordHash: string; fullName?: string; givenName?: string }): Promise<{ id: string } | 'google' | 'taken'>;
  findPasswordAccount(email: string): Promise<PasswordAccount | undefined>;
  touchAccount(accountId: string): Promise<void>;
}

type Env = Record<string, string | undefined>;

export const WRONG_CREDENTIALS = "That email and password don't match. Try again, or create an account.";
const TOO_MANY = 'Too many attempts. Please wait a few minutes and try again.';

function reply(status: number, body: Record<string, unknown>, cookies: string[] = []): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/** The posted form, after the same-origin check; a Response when the request can't be used. */
async function readForm(request: Request, env: Env): Promise<{ base: string; email: string; password: string; name?: string } | Response> {
  const base = appBaseUrl(env);
  if (!base) return reply(503, { error: 'Sign-in is not configured on this server.' });
  if (request.headers.get('origin') !== new URL(base).origin) return reply(403, { error: 'Unexpected origin' });
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return reply(400, { error: 'Invalid request' }); }
  const email = normalizeEmail(body?.email);
  if (!email) return reply(400, { error: 'Enter a valid email address.', field: 'email' });
  if (typeof body.password !== 'string' || !body.password) return reply(400, { error: 'Enter your password.', field: 'password' });
  if (body.password.length > MAX_PASSWORD) return reply(400, { error: `Use at most ${MAX_PASSWORD} characters for your password.`, field: 'password' });
  const name = cleanName(body.name);
  return { base, email, password: body.password, ...(name ? { name } : {}) };
}

/** POST /api/auth/password/sign-up {email, password, name?}: a new account, signed in. */
export function createPasswordSignUpHandler(store: PasswordStore, env: Env) {
  return async (request: Request): Promise<Response> => {
    const form = await readForm(request, env);
    if (form instanceof Response) return form;
    if (form.password.length < MIN_PASSWORD) return reply(400, { error: `Use at least ${MIN_PASSWORD} characters for your password.`, field: 'password' });
    if (!(await withinIpLimit(store, request, 'sign_up'))) return reply(429, { error: TOO_MANY });
    const givenName = form.name?.split(' ')[0];
    const created = await store.createPasswordAccount({ email: form.email, passwordHash: await hashPassword(form.password), fullName: form.name, givenName });
    if (created === 'google') return reply(409, { error: 'This email signs in with Google. Use Continue with Google above.', field: 'email' });
    if (created === 'taken') return reply(409, { error: 'An account with this email already exists. Sign in instead.', field: 'email' });
    const secure = isSecureRequest(request, form.base);
    const cookies = await beginLogin(store, request, { id: created.id, mainSessionId: null }, { email: form.email, emailVerified: false, fullName: form.name, givenName }, secure);
    if (cookies === 'limited') return reply(429, { error: 'Too many new conversations from this network. Try again later.' });
    return reply(200, { ok: true }, cookies);
  };
}

/**
 * POST /api/auth/password/sign-in {email, password}. An unknown email and a wrong password get the same
 * answer after the same work; attempts are limited per network and per email.
 */
export function createPasswordSignInHandler(store: PasswordStore, env: Env) {
  return async (request: Request): Promise<Response> => {
    const form = await readForm(request, env);
    if (form instanceof Response) return form;
    if (!(await withinIpLimit(store, request, 'sign_in'))) return reply(429, { error: TOO_MANY });
    if (store.consumeIpQuota && !(await store.consumeIpQuota(emailLimitKey(form.email), 'sign_in_email', ...IP_LIMITS.sign_in_email))) return reply(429, { error: TOO_MANY });
    const account = await store.findPasswordAccount(form.email);
    if (!account) {
      await spendPasswordCheck(form.password);
      return reply(401, { error: WRONG_CREDENTIALS });
    }
    if (!(await verifyPassword(form.password, account.passwordHash))) return reply(401, { error: WRONG_CREDENTIALS });
    await store.touchAccount(account.id);
    const secure = isSecureRequest(request, form.base);
    const cookies = await beginLogin(store, request, account, { email: account.email, emailVerified: false, fullName: account.fullName, givenName: account.givenName }, secure);
    if (cookies === 'limited') return reply(429, { error: 'Too many new conversations from this network. Try again later.' });
    return reply(200, { ok: true }, cookies);
  };
}
