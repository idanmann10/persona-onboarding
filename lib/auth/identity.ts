import type { SessionEvent } from '../domain/events';
import { createStore } from '../db/store';
import { getDatabase } from '../db/client';
import { createComposioClient } from '../integrations/composio';
import { isSecureRequest, sessionCookie } from './cookie';

/**
 * Identity comes from the Gmail connection itself: Google OAuth (through Composio managed auth) proves
 * the person owns the mailbox, and GMAIL_GET_PROFILE on that connected account names it. There is no
 * sign-up form. The first session to connect an address becomes its main session.
 */
export interface IdentityStore {
  getConnectionAttempt(sessionId: string, attemptId: string): Promise<{ toolkit: string; accountId: string; status: string } | undefined>;
  claimMainSession(email: string, sessionId: string): Promise<string | undefined>;
  appendEvent(sessionId: string, event: SessionEvent): Promise<void>;
}
export interface ProfileClient {
  executeRead(slug: string, accountId: string, userId: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface IdentityDeps {
  store: IdentityStore;
  client: ProfileClient;
  /**
   * Whether a second browser that proves the same address is moved into the main session. Off by default:
   * see the security note in signInWithGmail.
   */
  repointEnabled: boolean;
  appBaseUrl?: string;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/;

/** The mailbox address in a GMAIL_GET_PROFILE result, lowercased, or undefined when it is missing or malformed. */
export function profileEmail(data: unknown): string | undefined {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
  const nested = record?.response_data && typeof record.response_data === 'object' ? record.response_data as Record<string, unknown> : undefined;
  const value = record?.emailAddress ?? nested?.emailAddress;
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= 320 && EMAIL.test(email) ? email : undefined;
}

/**
 * Links a just-activated Gmail connection to its verified address. Never throws past the caller's
 * connection flow: any failure leaves the connection working and the session unlinked.
 */
export async function linkGmailIdentity(deps: IdentityDeps, request: Request, sessionId: string, attemptId: string, page: Response): Promise<Response> {
  // Only an attempt this session owns and that the connection service already verified and activated.
  const attempt = await deps.store.getConnectionAttempt(sessionId, attemptId);
  if (!attempt || attempt.toolkit !== 'gmail' || attempt.status !== 'active') return page;
  const email = profileEmail(await deps.client.executeRead('GMAIL_GET_PROFILE', attempt.accountId, sessionId, { user_id: 'me' }));
  if (!email) return page;
  const mainSessionId = await deps.store.claimMainSession(email, sessionId);
  if (!mainSessionId || mainSessionId === sessionId || !deps.repointEnabled) return page;
  // A second browser proved the same address: this browser joins the main session.
  await deps.store.appendEvent(mainSessionId, {
    id: `signin:${crypto.randomUUID()}`, at: new Date().toISOString(), type: 'decision', trigger: 'signin:another_browser', outcome: 'silent',
  });
  const headers = new Headers(page.headers);
  headers.set('Set-Cookie', sessionCookie(mainSessionId, isSecureRequest(request, deps.appBaseUrl)));
  headers.set('Cache-Control', 'no-store');
  return new Response(page.body, { status: page.status, headers });
}

let injected: IdentityDeps | undefined;
/** Tests inject fakes here; nothing runs under Vitest otherwise, so no test reaches a live service. */
export function setIdentityDeps(deps: IdentityDeps | undefined): void { injected = deps; }

function runtimeDeps(): IdentityDeps | undefined {
  if (injected) return injected;
  const key = process.env.COMPOSIO_API_KEY;
  if (process.env.VITEST || !key || !process.env.DATABASE_URL) return undefined;
  return {
    store: createStore(getDatabase()),
    client: createComposioClient(key),
    // SECURITY: keep off until the connect flow binds an OAuth completion to the browser that started it
    // (a per-attempt secret in the callback URL). Without it, a person tricked into completing an
    // attacker-started Gmail link would hand the attacker their main session, not just their mailbox.
    repointEnabled: process.env.PERSONA_CROSS_BROWSER_SIGN_IN === 'on',
    appBaseUrl: process.env.APP_BASE_URL,
  };
}

/** Called once from the OAuth callback after a Gmail connection becomes active. */
export async function signInWithGmail(request: Request, sessionId: string, attemptId: string, page: Response): Promise<Response> {
  const deps = runtimeDeps();
  if (!deps) return page;
  try { return await linkGmailIdentity(deps, request, sessionId, attemptId, page); }
  catch (error) {
    console.error('Gmail sign-in skipped', error instanceof Error ? error.message : 'unknown error');
    return page;
  }
}
