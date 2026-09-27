import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createStore } from '../../lib/db/store';
import { linkGmailIdentity, profileEmail, setIdentityDeps, type ProfileClient } from '../../lib/auth/identity';
import { createSignOutHandler } from '../../lib/auth/sign-out';
import { createSessionHandler } from '../../lib/http/session';
import { createConnectionHandlers } from '../../lib/http/connections';
import { createDeleteSessionHandler } from '../../lib/http/delete-session';

const database = `persona_auth_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const adminUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL || 'postgres://localhost/postgres');
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = postgres(adminUrl.toString(), { max: 1 });
let sql: ReturnType<typeof postgres>;
let store: ReturnType<typeof createStore>;

const APP = 'https://persona.example';
const EMAIL = 'ada.lovelace@example.com';
const page = () => new Response('<p>Connected.</p>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const callbackRequest = (sessionId: string, attemptId = crypto.randomUUID()) =>
  new Request(`${APP}/api/connections/callback?attempt=${attemptId}`, { headers: { cookie: `persona_session=${sessionId}` } });

/** A session with a Gmail attempt; `activate` mirrors what the connection service does after Composio verifies the account. */
async function gmailAttempt(sessionId: string, { activate = true, toolkit = 'gmail' as 'gmail' | 'calendar' } = {}) {
  const attemptId = crypto.randomUUID();
  if (!(await store.sessionExists(sessionId))) await store.createSession(sessionId);
  await store.createConnectionAttempt(sessionId, attemptId, toolkit, `ca_${attemptId}`, `ac_${toolkit}`, new Date(Date.now() + 600_000).toISOString());
  if (activate) await store.activateConnection(sessionId, attemptId);
  return attemptId;
}

function profile(result: unknown): ProfileClient & { calls: Array<{ slug: string; accountId: string; userId: string }> } {
  const calls: Array<{ slug: string; accountId: string; userId: string }> = [];
  return {
    calls,
    executeRead: async (slug: string, accountId: string, userId: string) => {
      calls.push({ slug, accountId, userId });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

async function userRow(email: string) {
  const rows = await sql`SELECT main_session_id FROM persona_users WHERE email = ${email}`;
  return rows[0]?.main_session_id as string | undefined;
}

describe('Gmail-verified identity and the main session', () => {
  const main = crypto.randomUUID();

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${database} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
    sql = postgres(testUrl.toString(), { max: 1 });
    store = createStore(sql);
    await store.initialize();
  });

  afterAll(async () => {
    setIdentityDeps(undefined);
    if (sql) await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  });

  it('reads the address from a Gmail profile, lowercased, and rejects anything else', () => {
    expect(profileEmail({ emailAddress: ' Ada.Lovelace@Example.COM ', messagesTotal: 3 })).toBe(EMAIL);
    expect(profileEmail({ response_data: { emailAddress: EMAIL } })).toBe(EMAIL);
    for (const bad of [undefined, null, {}, { emailAddress: 'not-an-email' }, { emailAddress: 42 }, { emailAddress: 'a@b' }]) expect(profileEmail(bad)).toBeUndefined();
  });

  it('makes the first session to prove an address its main session, and /api/session reports it', async () => {
    const attemptId = await gmailAttempt(main);
    const client = profile({ emailAddress: 'Ada.Lovelace@Example.com' });
    const response = await linkGmailIdentity({ store, client, repointEnabled: true, appBaseUrl: APP }, callbackRequest(main), main, attemptId, page());
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(client.calls).toEqual([{ slug: 'GMAIL_GET_PROFILE', accountId: `ca_${attemptId}`, userId: main }]);
    expect(await userRow(EMAIL)).toBe(main);

    const session = await createSessionHandler(store)(new Request(`${APP}/api/session`, { headers: { cookie: `persona_session=${main}` } }));
    expect((await session.json()).account).toEqual({ email: EMAIL });
    const guest = crypto.randomUUID();
    await store.createSession(guest);
    const guestSession = await createSessionHandler(store)(new Request(`${APP}/api/session`, { headers: { cookie: `persona_session=${guest}` } }));
    expect((await guestSession.json()).account).toBeNull();
  });

  it('moves a second browser that proves the same address into the main session and records it there', async () => {
    const second = crypto.randomUUID();
    const attemptId = await gmailAttempt(second);
    const response = await linkGmailIdentity({ store, client: profile({ emailAddress: 'ADA.LOVELACE@example.com' }), repointEnabled: true, appBaseUrl: APP }, callbackRequest(second), second, attemptId, page());
    expect(response.headers.get('set-cookie')).toBe(`persona_session=${main}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`);
    expect(await response.text()).toBe('<p>Connected.</p>');
    expect((await store.readEvents(main)).filter((event) => event.type === 'decision' && event.trigger === 'signin:another_browser')).toHaveLength(1);
    expect((await store.readEvents(second)).some((event) => event.type === 'decision')).toBe(false);
    expect(await userRow(EMAIL)).toBe(main);
    expect(await store.getSessionAccount(second)).toBeUndefined();
  });

  it('leaves a second browser in its own session while cross-browser sign-in is off', async () => {
    const second = crypto.randomUUID();
    const attemptId = await gmailAttempt(second);
    const before = (await store.readEvents(main)).length;
    const response = await linkGmailIdentity({ store, client: profile({ emailAddress: EMAIL }), repointEnabled: false }, callbackRequest(second), second, attemptId, page());
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await store.readEvents(main)).length).toBe(before);
  });

  it('does nothing without a verified profile or an active Gmail connection this session owns', async () => {
    const other = crypto.randomUUID();
    const attemptId = await gmailAttempt(other);
    for (const result of [new Error('Composio request failed (401)'), {}, { emailAddress: 'not-an-email' }]) {
      setIdentityDeps({ store, client: profile(result), repointEnabled: true, appBaseUrl: APP });
      const { signInWithGmail } = await import('../../lib/auth/identity');
      const response = await signInWithGmail(callbackRequest(other), other, attemptId, page());
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.status).toBe(200);
    }
    setIdentityDeps(undefined);
    expect(await store.getSessionAccount(other)).toBeUndefined();

    // Someone else's attempt, a pending attempt, and a Calendar attempt never reach the profile call.
    const pending = await gmailAttempt(other, { activate: false });
    const calendar = await gmailAttempt(other, { toolkit: 'calendar' });
    const mainAttempt = await gmailAttempt(main, { activate: false });
    const client = profile({ emailAddress: EMAIL });
    for (const attempt of [pending, calendar, mainAttempt]) {
      const response = await linkGmailIdentity({ store, client, repointEnabled: true }, callbackRequest(other), other, attempt, page());
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(client.calls).toEqual([]);

    // A main session does not collect a second address.
    const switched = await gmailAttempt(main);
    const response = await linkGmailIdentity({ store, client: profile({ emailAddress: 'bob@example.com' }), repointEnabled: true }, callbackRequest(main), main, switched, page());
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await userRow('bob@example.com')).toBeUndefined();
    expect(await store.getSessionAccount(main)).toEqual({ email: EMAIL });
  });

  it('runs from the OAuth callback, and a failed profile never fails the connection', async () => {
    const service = {
      start: async () => ({ attemptId: '', redirectUrl: '' }),
      finish: async (sessionId: string, attemptId: string) => { await store.activateConnection(sessionId, attemptId); return 'gmail' as const; },
      disconnect: async () => {},
    };
    const handlers = createConnectionHandlers(store, service, APP);
    try {
      const second = crypto.randomUUID();
      const attemptId = await gmailAttempt(second, { activate: false });
      setIdentityDeps({ store, client: profile({ emailAddress: EMAIL }), repointEnabled: true, appBaseUrl: APP });
      const moved = await handlers.callback(new Request(`${APP}/api/connections/callback?attempt=${attemptId}`, { headers: { cookie: `persona_session=${second}` } }));
      expect(moved.headers.get('set-cookie')).toContain(`persona_session=${main};`);
      expect(await moved.text()).toContain('"status":"connected"');

      const third = crypto.randomUUID();
      const failingAttempt = await gmailAttempt(third, { activate: false });
      setIdentityDeps({ store, client: profile(new Error('Composio request failed (500)')), repointEnabled: true, appBaseUrl: APP });
      const kept = await handlers.callback(new Request(`${APP}/api/connections/callback?attempt=${failingAttempt}`, { headers: { cookie: `persona_session=${third}` } }));
      expect(kept.headers.get('set-cookie')).toBeNull();
      expect(await kept.text()).toContain('"status":"connected"');
      expect((await store.readEvents(third)).map((event) => event.type === 'connection' ? event.phase : event.type)).toEqual(['connected']);
    } finally { setIdentityDeps(undefined); }
  });

  it('signs out with a same-origin POST only, clearing the cookie and keeping the data', async () => {
    const signOut = createSignOutHandler(APP);
    const request = (origin: string) => new Request(`${APP}/api/auth/sign-out`, { method: 'POST', headers: { origin, cookie: `persona_session=${main}` } });
    const refused = await signOut(request('https://evil.example'));
    expect(refused.status).toBe(403);
    expect(refused.headers.get('set-cookie')).toBeNull();
    const done = await signOut(request(APP));
    expect(done.status).toBe(204);
    expect(done.headers.get('set-cookie')).toBe('persona_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
    expect(await store.sessionExists(main)).toBe(true);
    expect(await userRow(EMAIL)).toBe(main);
    const local = await createSignOutHandler('http://localhost:3000')(new Request('http://localhost:3000/api/auth/sign-out', { method: 'POST', headers: { origin: 'http://localhost:3000' } }));
    expect(local.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('Start over on a main session deletes the account, so the address starts fresh', async () => {
    const deleted: string[] = [];
    const remove = createDeleteSessionHandler(store, { deleteAccount: async (id: string) => { deleted.push(id); } }, APP);
    const response = await remove(new Request(`${APP}/api/session`, { method: 'DELETE', headers: { origin: APP, cookie: `persona_session=${main}` } }));
    expect(response.status).toBe(204);
    expect(deleted.length).toBeGreaterThan(0);
    expect(await userRow(EMAIL)).toBeUndefined();

    const fresh = crypto.randomUUID();
    const attemptId = await gmailAttempt(fresh);
    const linked = await linkGmailIdentity({ store, client: profile({ emailAddress: EMAIL }), repointEnabled: true, appBaseUrl: APP }, callbackRequest(fresh), fresh, attemptId, page());
    expect(linked.headers.get('set-cookie')).toBeNull();
    expect(await userRow(EMAIL)).toBe(fresh);
  });
});
