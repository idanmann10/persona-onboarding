import { createHash, randomBytes } from 'node:crypto';
import type { SessionEvent } from '../domain/events';
import { withinIpLimit, type IpQuotaStore } from '../http/client-key';
import { AUTH_COOKIE, readCookie } from './cookie';
import { recordFacts, locationFacts, profileFacts, type FactStore } from './profile';

/**
 * Who is signed in. A signed-in browser holds a random token (the persona_auth cookie); the server
 * keeps only its SHA-256, so a database read cannot be replayed as a login, and signing out deletes it.
 * One account (Google, or email + password) is one user with one main conversation: every browser it
 * signs in on opens the same one, and "Start over" swaps it for a fresh one.
 */
export interface SignedInUser {
  accountId: string;
  /** The user's main conversation, or null after "Start over" until the next page load opens a new one. */
  sessionId: string | null;
  email: string;
  /** True for Google accounts; a password account's email was only typed, never proven. */
  emailVerified: boolean;
  fullName?: string;
  givenName?: string;
  picture?: string;
  locale?: string;
}

export interface LoginStore {
  /** The user behind an unexpired login, by the hash of its token. */
  findLogin(tokenHash: string): Promise<SignedInUser | undefined>;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const newLoginToken = (): string => randomBytes(32).toString('base64url');
export const hashLoginToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** This browser's login token when it is well formed; nothing is looked up. */
export function readLoginToken(request: Request): string | undefined {
  const token = readCookie(request, AUTH_COOKIE);
  return token && TOKEN.test(token) ? token : undefined;
}

/** The signed-in user making this request, or undefined: the route answers 401. */
export async function signedInUser(store: LoginStore, request: Request): Promise<SignedInUser | undefined> {
  const token = readLoginToken(request);
  return token ? store.findLogin(hashLoginToken(token)) : undefined;
}

/**
 * The signed-in user's conversation, for every route that reads or changes it. Undefined when nobody is
 * signed in, or the user started over and no page has opened the new conversation yet.
 */
export async function signedInSession(store: LoginStore, request: Request): Promise<string | undefined> {
  return (await signedInUser(store, request))?.sessionId ?? undefined;
}

export interface MainSessionStore extends IpQuotaStore, FactStore {
  /**
   * The account's main conversation. When it has none, it takes over the conversation `verifiedEmail` had
   * under the retired Gmail sign-in (Google accounts only), or else `newSessionId` is created for it.
   */
  claimMainSession(accountId: string, verifiedEmail: string | undefined, newSessionId: string): Promise<{ id: string; created: boolean }>;
}

/**
 * The user's main conversation with its events, opened on first use: a new one starts with the greeting
 * and what sign-in told us about them. 'limited' when this network has started too many conversations.
 */
export async function openMainSession(store: MainSessionStore, user: SignedInUser, request: Request): Promise<{ id: string; created: boolean; events: SessionEvent[] } | 'limited'> {
  if (user.sessionId) return { id: user.sessionId, created: false, events: await store.readEvents(user.sessionId) };
  if (!(await withinIpLimit(store, request, 'session'))) return 'limited';
  const session = await store.claimMainSession(user.accountId, user.emailVerified ? user.email : undefined, crypto.randomUUID());
  let events = await store.readEvents(session.id);
  if (await recordFacts(store, session.id, [...profileFacts(user), ...locationFacts(request)], events, 'signin:profile')) events = await store.readEvents(session.id);
  // No greeting here: the assistant writes its own first message from these facts (POST /api/agent/greeting).
  return { ...session, events };
}
