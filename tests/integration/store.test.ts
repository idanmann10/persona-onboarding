import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { SessionEvent } from '../../lib/domain/events';
import { createStore } from '../../lib/db/store';
import { runTextTurn } from '../../lib/agent/chat';
import { getGuestSession } from '../../lib/agent/session';
import { createSessionHandler } from '../../lib/http/session';
import { createChatHandler } from '../../lib/http/chat';
import { createVoiceSessionHandler } from '../../lib/http/voice';
import { createVoiceEventHandler } from '../../lib/http/voice-events';
import { projectSession } from '../../lib/domain/project';
import { resolveIdentityClaim } from '../../lib/research/service';

const database = `persona_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const adminUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL || 'postgres://localhost/postgres');
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = postgres(adminUrl.toString(), { max: 1 });
let sql: ReturnType<typeof postgres>;
async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('Postgres session store', () => {
  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${database}`);
    sql = postgres(testUrl.toString(), { max: 1 });
    await createStore(sql).initialize();
  });

  afterAll(async () => {
    if (sql) await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  });

  it('persists a guest session and appends each event only once', async () => {
    const store = createStore(sql);
    const sessionId = crypto.randomUUID();
    const event: SessionEvent = { id: 'm1', at: new Date().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: 'Help me plan my week' };
    await store.createSession(sessionId);
    await store.appendEvent(sessionId, event);
    await store.appendEvent(sessionId, event);
    const reloaded = createStore(sql);
    expect(await reloaded.sessionExists(sessionId)).toBe(true);
    expect(await reloaded.readEvents(sessionId)).toEqual([event]);
  });

  it('streams an answer, saves it, and reuses it on a retried turn', async () => {
    const store = createStore(sql);
    const sessionId = crypto.randomUUID();
    await store.createSession(sessionId);
    const event: SessionEvent = { id: 'm2', at: new Date().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: 'Plan my week' };
    let calls = 0;
    const respond = async function* () { calls += 1; yield 'Let us '; yield 'start with Monday.'; };
    const first = await collect(runTextTurn(store, sessionId, event, respond));
    const retry = await collect(runTextTurn(store, sessionId, event, respond));
    expect(first.join('')).toBe('Let us start with Monday.');
    expect(retry.join('')).toBe(first.join(''));
    expect(calls).toBe(1);
    expect((await store.readEvents(sessionId)).filter((item) => item.type === 'message')).toHaveLength(2);
  });

  it('reuses an owned guest session and replaces an unknown cookie', async () => {
    const store = createStore(sql);
    const first = await getGuestSession(store);
    expect(first.created).toBe(true);
    const second = await getGuestSession(store, first.id);
    expect(second).toEqual({ id: first.id, created: false, events: [] });
    const invalid = await getGuestSession(store, crypto.randomUUID());
    expect(invalid.created).toBe(true);
    expect(invalid.id).not.toBe(first.id);
  });

  it('issues an HttpOnly cookie, reloads history, and streams an authorized text turn', async () => {
    const store = createStore(sql);
    const sessionHandler = createSessionHandler(store);
    const first = await sessionHandler(new Request('http://localhost/api/session'));
    const cookie = first.headers.get('set-cookie') || '';
    expect(cookie).toMatch(/persona_session=.+HttpOnly/i);
    const cookieHeader = cookie.split(';')[0];
    const chatHandler = createChatHandler(store, async function* () { yield 'I can help with that.'; });
    const rejected = await chatHandler(new Request('http://localhost/api/chat', { method: 'POST', body: JSON.stringify({ id: 'm3', text: 'hello' }) }));
    expect(rejected.status).toBe(401);
    const reply = await chatHandler(new Request('http://localhost/api/chat', { method: 'POST', headers: { cookie: cookieHeader }, body: JSON.stringify({ id: 'm3', text: 'hello' }) }));
    expect(reply.status).toBe(200);
    expect(await reply.text()).toBe('I can help with that.');
    const reloaded = await sessionHandler(new Request('http://localhost/api/session', { headers: { cookie: cookieHeader } }));
    const snapshot = await reloaded.json();
    expect(snapshot.messages).toEqual([
      { id: 'm3', role: 'user', text: 'hello' },
      { id: 'answer:m3', role: 'assistant', text: 'I can help with that.' },
    ]);
  });

  it('creates a browser voice session with prior text and evidence-labelled state only for the owning cookie', async () => {
    const store = createStore(sql);
    const session = await getGuestSession(store);
    await store.appendEvent(session.id, { id: 'voice-context', at: new Date().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: 'I need help preparing for Friday' });
    await store.appendEvent(session.id, { id: 'voice-fact', at: new Date().toISOString(), type: 'fact', key: 'preferred_pace', value: 'concise', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'voice-context' });
    await store.appendEvent(session.id, { id: 'voice-prior', at: new Date().toISOString(), type: 'voice_fragment', speaker: 'user', text: 'I might need a short brief', final: false, callId: 'live_old', startMs: 0, endMs: 1000 });
    let sent: Record<string, unknown> | undefined;
    const upstream = async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'answer-sdp' } }), { status: 201 });
    };
    const handler = createVoiceSessionHandler(store, 'server-secret', upstream);
    const request = (cookie?: string) => new Request('http://localhost/api/voice/session', { method: 'POST', headers: { origin: 'http://localhost', ...(cookie ? { cookie: `persona_session=${cookie}` } : {}) }, body: JSON.stringify({ sdp: 'offer-sdp' }) });
    expect((await handler(request())).status).toBe(401);
    const result = await handler(request(session.id));
    expect(result.status).toBe(201);
    expect((await handler(request(session.id))).status).toBe(409);
    expect(await result.json()).toEqual({ session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'answer-sdp' } });
    expect(JSON.stringify(sent)).toContain('I need help preparing for Friday');
    expect(JSON.stringify(sent)).toContain('preferred_pace');
    expect(JSON.stringify(sent)).toContain('I might need a short brief');
    expect(JSON.stringify(sent)).toContain('offer-sdp');
    expect(JSON.stringify(sent)).not.toContain('server-secret');
  });

  it('stores transcript fragments and a dropped-call state without confirming speech as a fact', async () => {
    const store = createStore(sql);
    const session = await getGuestSession(store);
    expect(await store.acquireCallLease(session.id, 'lease-live-one')).toBe(true);
    expect(await store.bindCallLease(session.id, 'lease-live-one', 'live_one')).toBe(true);
    await store.appendEvent(session.id, { id: 'call:live_one:accepted', at: new Date().toISOString(), type: 'call', phase: 'accepted', callId: 'live_one' });
    const handler = createVoiceEventHandler(store);
    const post = (body: object) => new Request('http://localhost/api/voice/event', { method: 'POST', headers: { origin: 'http://localhost', cookie: `persona_session=${session.id}` }, body: JSON.stringify(body) });
    expect((await handler(post({ callId: 'live_other', kind: 'started' }))).status).toBe(404);
    expect((await handler(post({ callId: 'live_one', kind: 'started' }))).status).toBe(204);
    expect((await handler(post({ callId: 'live_one', kind: 'heartbeat' }))).status).toBe(204);
    const fragment = { callId: 'live_one', kind: 'transcript', eventId: 'evt-1', speaker: 'user', text: 'I maybe work at North...', startMs: 1000, endMs: 1400 };
    expect((await handler(post(fragment))).status).toBe(204);
    expect((await handler(post(fragment))).status).toBe(204);
    expect((await handler(post({ callId: 'live_one', kind: 'dropped' }))).status).toBe(204);
    expect(await store.acquireCallLease(session.id, 'lease-after-drop')).toBe(true);
    const state = projectSession(await store.readEvents(session.id));
    expect(state.call.phase).toBe('dropped');
    expect(state.voiceFragments).toHaveLength(1);
    expect(state.voiceFragments[0].final).toBe(false);
    expect(state.facts.company).toBeUndefined();
    const snapshot = await createSessionHandler(store)(new Request('http://localhost/api/session', { headers: { cookie: `persona_session=${session.id}` } }));
    expect((await snapshot.json()).voiceFragments).toEqual([{ speaker: 'user', text: 'I maybe work at North...', startMs: 1000, endMs: 1400, callId: 'live_one' }]);
  });

  it('allows only one active call lease per session and releases it on hangup', async () => {
    const store = createStore(sql);
    const id = crypto.randomUUID();
    await store.createSession(id);
    const results = await Promise.all([store.acquireCallLease(id, 'lease-one'), store.acquireCallLease(id, 'lease-two')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winning = results[0] ? 'lease-one' : 'lease-two';
    expect(await store.bindCallLease(id, winning, 'live_one')).toBe(true);
    expect(await store.refreshCallLease(id, 'live_one')).toBe(true);
    expect(await store.acquireCallLease(id, 'lease-three')).toBe(false);
    await store.releaseCallLease(id, 'live_one');
    expect(await store.acquireCallLease(id, 'lease-three')).toBe(true);
  });

  it('projects sourced graph facts and supersedes a correction in SQL', async () => {
    const store = createStore(sql);
    const sessionId = crypto.randomUUID();
    await store.createSession(sessionId);
    await store.appendEvent(sessionId, { id: 'fact-1', at: new Date().toISOString(), type: 'fact', key: 'company', value: 'Old Co', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'message-1' });
    await store.appendEvent(sessionId, { id: 'fact-2', at: new Date().toISOString(), type: 'fact', key: 'company', value: 'New Co', evidence: 'confirmed', provenance: 'user_confirmed', sourceEventId: 'message-2', sourceUrl: 'https://example.org/new-co' });
    const facts = await store.readGraphFacts(sessionId);
    expect(facts.map((fact) => [fact.value, fact.evidence])).toEqual([['Old Co', 'superseded'], ['New Co', 'confirmed']]);
    expect(facts[1].provenance).toBe('user_confirmed');
    expect(facts[1].sourceUrl).toBe('https://example.org/new-co');
  });

  it('automatically checks only a direct user identity claim and keeps public identity tentative', async () => {
    const store = createStore(sql);
    const sessionId = crypto.randomUUID();
    await store.createSession(sessionId);
    const userEvent: SessionEvent = { id: 'identity-message', at: new Date().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: "I'm Jordan Lee, founder of Northstar Analytics." };
    await store.appendEvent(sessionId, userEvent);
    let calls = 0;
    const lookup = async () => { calls++; return { status: 'matched_for_research' as const, score: .97, name: 'Jordan Lee', company: 'Northstar Analytics', sourceUrl: 'https://example.org/jordan', requestId: 'req-1' }; };
    const clue = { first: 'Jordan', last: 'Lee', company: 'Northstar Analytics' };
    let researchCalls = 0;
    const research = async () => { researchCalls++; return { role: 'Founder', companySummary: 'Analytics software.', sources: ['https://example.org/about'], partial: false }; };
    const result = await resolveIdentityClaim(store, sessionId, userEvent, clue, 'test-key', lookup, research);
    await resolveIdentityClaim(store, sessionId, userEvent, clue, 'test-key', lookup, research);
    expect(result.status).toBe('matched_for_research');
    expect(calls).toBe(1);
    expect(researchCalls).toBe(1);
    const facts = await store.readGraphFacts(sessionId);
    expect(facts.find((fact) => fact.key === 'public_identity_candidate')).toMatchObject({ evidence: 'tentative', provenance: 'tool_observed', sourceUrl: 'https://example.org/jordan' });
    expect(facts.find((fact) => fact.key === 'public_company_summary')).toMatchObject({ evidence: 'tentative', value: 'Analytics software.', sourceUrl: 'https://example.org/about' });
    expect(facts.find((fact) => fact.key === 'public_research_status')).toMatchObject({ value: 'complete', provenance: 'tool_observed' });
  });

  it('removes prior public research when the user corrects their identity', async () => {
    const store = createStore(sql);
    const sessionId = crypto.randomUUID();
    await store.createSession(sessionId);
    const first: SessionEvent = { id: 'identity-old', at: new Date().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: "I'm Jordan Lee, founder of Northstar Analytics." };
    await store.appendEvent(sessionId, first);
    await resolveIdentityClaim(store, sessionId, first, { first: 'Jordan', last: 'Lee', company: 'Northstar Analytics' }, 'key',
      async () => ({ status: 'matched_for_research', score: .97, name: 'Jordan Lee', company: 'Northstar Analytics', sourceUrl: 'https://example.org/jordan' }),
      async () => ({ role: 'Founder', sources: ['https://example.org/jordan'], partial: false }));
    const correction: SessionEvent = { id: 'identity-new', at: new Date().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: "I'm Sam Lee, founder of New Company." };
    await store.appendEvent(sessionId, correction);
    await resolveIdentityClaim(store, sessionId, correction, { first: 'Sam', last: 'Lee', company: 'New Company' }, 'key', async () => null, async () => null);
    const state = projectSession(await store.readEvents(sessionId));
    expect(state.facts.name.value).toBe('Sam Lee');
    expect(state.facts.public_identity_candidate).toBeUndefined();
    expect(state.facts.public_role).toBeUndefined();
  });

  it('binds a connected account attempt to its owning session and only activates it after verification', async () => {
    const store = createStore(sql);
    const owner = crypto.randomUUID();
    const stranger = crypto.randomUUID();
    await store.createSession(owner);
    await store.createSession(stranger);
    const attempt = crypto.randomUUID();
    await store.createConnectionAttempt(owner, attempt, 'calendar', 'ca_calendar', 'auth_calendar', new Date(Date.now() + 60_000).toISOString());
    expect(await store.getConnectionAttempt(stranger, attempt)).toBeUndefined();
    expect(await store.getActiveConnection(owner, 'calendar')).toBeUndefined();
    expect(await store.getConnectionAttempt(owner, attempt)).toMatchObject({ accountId: 'ca_calendar', authConfigId: 'auth_calendar' });
    expect(await store.activateConnection(stranger, attempt)).toBe(false);
    expect(await store.activateConnection(owner, attempt)).toBe(true);
    expect(await store.getActiveConnection(owner, 'calendar')).toBe('ca_calendar');
    expect(await store.getActiveConnection(stranger, 'calendar')).toBeUndefined();
    expect(await store.deactivateConnection(stranger, 'calendar', 'ca_calendar')).toBe(false);
    expect(await store.deactivateConnection(owner, 'calendar', 'ca_calendar')).toBe(true);
    expect(await store.getActiveConnection(owner, 'calendar')).toBeUndefined();
  });

  it('deletes a session and cascades its messages, graph facts, and connections', async () => {
    const store = createStore(sql);
    const id = crypto.randomUUID();
    await store.createSession(id);
    await store.appendEvent(id, { id: 'delete-me', at: new Date().toISOString(), type: 'fact', key: 'name', value: 'Jordan Lee', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm1' });
    await store.createConnectionAttempt(id, crypto.randomUUID(), 'gmail', 'ca_delete', 'auth_gmail', new Date(Date.now() + 60_000).toISOString());
    expect(await store.listConnectionAccounts(id)).toEqual(['ca_delete']);
    await store.deleteSession(id);
    expect(await store.sessionExists(id)).toBe(false);
    expect(await store.readEvents(id)).toEqual([]);
    expect(await store.readGraphFacts(id)).toEqual([]);
    expect(await store.listConnectionAccounts(id)).toEqual([]);
  });
});
