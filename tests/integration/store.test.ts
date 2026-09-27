import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { SessionEvent } from '../../lib/domain/events';
import { createStore } from '../../lib/db/store';
import { runTextTurn } from '../../lib/agent/chat';
import { getGuestSession, GREETING_TEXT } from '../../lib/agent/session';
import { createSessionHandler } from '../../lib/http/session';
import { createChatHandler } from '../../lib/http/chat';
import { createVoiceSessionHandler } from '../../lib/http/voice';
import { createVoiceEventHandler } from '../../lib/http/voice-events';
import { projectSession } from '../../lib/domain/project';
import { resolveIdentityClaim } from '../../lib/research/service';
import { createFollowUpHandler } from '../../lib/http/follow-up';
import { createVoiceToolHandler } from '../../lib/http/voice-tool';
import { createCallOfferHandler } from '../../lib/http/call-offer';
import { createAutomationHandler, createDueRunner } from '../../lib/http/automations';
import { proposeAutomation } from '../../lib/agent/actions';
import { nextRun } from '../../lib/domain/schedule';

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
    expect(second).toEqual({ id: first.id, created: false, events: [expect.objectContaining({ id: 'greeting:v1', speaker: 'assistant', origin: 'greeting', text: GREETING_TEXT })] });
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
    const forbidden = await chatHandler(new Request('http://localhost/api/chat', { method: 'POST', headers: { cookie: cookieHeader, origin: 'http://evil.example' }, body: JSON.stringify({ id: 'm3', text: 'hello' }) }));
    expect(forbidden.status).toBe(403);
    const reply = await chatHandler(new Request('http://localhost/api/chat', { method: 'POST', headers: { cookie: cookieHeader, origin: 'http://localhost' }, body: JSON.stringify({ id: 'm3', text: 'hello' }) }));
    expect(reply.status).toBe(200);
    expect(await reply.text()).toBe('I can help with that.');
    const reloaded = await sessionHandler(new Request('http://localhost/api/session', { headers: { cookie: cookieHeader } }));
    const snapshot = await reloaded.json();
    expect(snapshot.messages).toEqual([
      { id: 'greeting:v1', role: 'assistant', text: GREETING_TEXT },
      { id: 'm3', role: 'user', text: 'hello' },
      { id: 'answer:m3', role: 'assistant', text: 'I can help with that.' },
    ]);
    const sessionId = cookieHeader.split('=')[1];
    for (let i = 0; i < 12; i++) await store.consumeQuota(sessionId, 'chat', 12, 60);
    const limited = await chatHandler(new Request('http://localhost/api/chat', { method: 'POST', headers: { cookie: cookieHeader, origin: 'http://localhost' }, body: JSON.stringify({ id: 'm4', text: 'again' }) }));
    expect(limited.status).toBe(429);
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
    await store.releaseCallLease(session.id, 'live_test');
    for (let i = 0; i < 3; i++) await store.consumeQuota(session.id, 'voice', 3, 600);
    expect((await handler(request(session.id))).status).toBe(429);
    const answer = await result.json();
    expect(answer).toMatchObject({ session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'answer-sdp' }, delegation: true });
    expect(answer.greeting).toMatch(/^Greet the caller now in English\. .*ask what you should call them/);
    expect(answer.limits).toMatchObject({ checkInAfterMs: 20_000, closeAfterMs: 30_000, maxDurationMs: 720_000 });
    const liveSession = (sent as { session: { model: string; input: Array<{ role: string }>; delegation: { type: string; responses: { model: string; tools: Array<{ name: string }> } } } }).session;
    expect(liveSession.model).toBe('gpt-live-1');
    expect(liveSession.input[0].role).toBe('developer');
    expect(liveSession.delegation).toMatchObject({ type: 'responses', responses: { model: 'gpt-6-luna' } });
    expect(liveSession.delegation.responses.tools.map((tool) => tool.name)).toEqual(['remember', 'note_decline']);
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

  it('atomically caps paid operations by session and window', async () => {
    const store = createStore(sql);
    const id = crypto.randomUUID();
    await store.createSession(id);
    const results = await Promise.all([store.consumeQuota(id, 'chat', 2, 60), store.consumeQuota(id, 'chat', 2, 60), store.consumeQuota(id, 'chat', 2, 60)]);
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await store.consumeQuota(id, 'voice', 1, 600)).toBe(true);
    expect(await store.consumeQuota(id, 'voice', 1, 600)).toBe(false);
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

  it('does not call person enrichment after a session reaches its research quota', async () => {
    const store = createStore(sql);
    const id = crypto.randomUUID();
    await store.createSession(id);
    for (let i = 0; i < 5; i++) await store.consumeQuota(id, 'research', 5, 86_400);
    const event: SessionEvent = { id: 'rate-identity', at: new Date().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: "I'm Jordan Lee, founder of Northstar Analytics." };
    await store.appendEvent(id, event);
    let lookupCalls = 0;
    const result = await resolveIdentityClaim(store, id, event, { first: 'Jordan', last: 'Lee', company: 'Northstar Analytics' }, 'key', async () => { lookupCalls++; return null; }, async () => null);
    expect(result.status).toBe('rate_limited');
    expect(lookupCalls).toBe(0);
  });

  it('reserves an identity claim once across concurrent attempts', async () => {
    const store = createStore(sql);
    const id = crypto.randomUUID();
    await store.createSession(id);
    const event: SessionEvent = { id: 'concurrent-identity', at: new Date().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: "I'm Jordan Lee, founder of Northstar Analytics." };
    await store.appendEvent(id, event);
    let lookups = 0;
    const lookup = async () => { lookups++; await new Promise((resolve) => setTimeout(resolve, 10)); return null; };
    const clue = { first: 'Jordan', last: 'Lee', company: 'Northstar Analytics' };
    const results = await Promise.all([resolveIdentityClaim(store, id, event, clue, 'key', lookup, async () => null), resolveIdentityClaim(store, id, event, clue, 'key', lookup, async () => null)]);
    expect(lookups).toBe(1);
    expect(results.map((result) => result.status).sort()).toEqual(['already_checked', 'not_found']);
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

  async function liveCall(store: ReturnType<typeof createStore>, callId = 'live_call') {
    const session = await getGuestSession(store);
    expect(await store.acquireCallLease(session.id, `lease-${callId}`)).toBe(true);
    expect(await store.bindCallLease(session.id, `lease-${callId}`, callId)).toBe(true);
    await store.appendEvent(session.id, { id: `call:${callId}:accepted`, at: new Date().toISOString(), type: 'call', phase: 'accepted', callId });
    return session.id;
  }
  const request = (url: string, sessionId: string, body: unknown, origin = 'http://localhost', method = 'POST') =>
    new Request(url, { method, headers: { origin, cookie: `persona_session=${sessionId}` }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('texts once after a mid-sentence hangup, including when the tab closed before asking', async () => {
    const store = createStore(sql);
    const sessionId = await liveCall(store);
    const events = createVoiceEventHandler(store);
    expect((await events(request('http://localhost/api/voice/event', sessionId, { callId: 'live_call', kind: 'started' }))).status).toBe(204);
    expect((await events(request('http://localhost/api/voice/event', sessionId, { callId: 'live_call', kind: 'transcripts', fragments: [
      { eventId: 'a1', speaker: 'assistant', text: "What's eating your week?", startMs: 0, endMs: 900 },
      { eventId: 'u1', speaker: 'user', text: 'honestly the investor updates, every month I', startMs: 1_200, endMs: 3_000 },
    ] }))).status).toBe(204);
    expect((await events(request('http://localhost/api/voice/event', sessionId, { callId: 'live_call', kind: 'transcripts', fragments: [{ eventId: 'bad', speaker: 'robot', text: 'x', startMs: 0, endMs: 1 }] }))).status).toBe(400);
    const run: Array<{ id: string; instruction: string }> = [];
    const followUp = createFollowUpHandler(store, async (_history, _id, trigger) => { run.push(trigger); return 'Hey, looks like we got cut off. You were saying the investor updates eat your month. Want me to take a first pass at the next one?'; });
    expect((await followUp(request('http://localhost/api/agent/follow-up', sessionId, { kind: 'call_ended', callId: 'live_call' }))).status).toBe(409);
    expect((await events(request('http://localhost/api/voice/event', sessionId, { callId: 'live_call', kind: 'ended', reason: 'user_hangup' }))).status).toBe(204);
    const pending = await (await createSessionHandler(store)(request('http://localhost/api/session', sessionId, undefined, 'http://localhost', 'GET'))).json();
    expect(pending.pendingFollowUps).toEqual([{ kind: 'call_ended', callId: 'live_call' }]);
    const first = await followUp(request('http://localhost/api/agent/follow-up', sessionId, { kind: 'call_ended', callId: 'live_call' }));
    expect(await first.json()).toMatchObject({ status: 'messaged', message: { id: 'answer:followup:call:live_call', role: 'assistant' } });
    expect(run).toHaveLength(1);
    expect(run[0].instruction).toContain('the user hung up');
    expect(run[0].instruction).toContain('may have been cut off mid-sentence');
    expect(run[0].instruction).not.toContain('every month I');
    const retry = await followUp(request('http://localhost/api/agent/follow-up', sessionId, { kind: 'call_ended', callId: 'live_call' }));
    expect(await retry.json()).toMatchObject({ status: 'messaged' });
    expect(run).toHaveLength(1);
    const snapshot = await (await createSessionHandler(store)(request('http://localhost/api/session', sessionId, undefined, 'http://localhost', 'GET'))).json();
    expect(snapshot.pendingFollowUps).toEqual([]);
    expect(snapshot.timeline.at(-1)).toMatchObject({ kind: 'message', speaker: 'assistant', origin: 'follow_up' });
    const call = snapshot.timeline.find((item: { kind: string }) => item.kind === 'call');
    expect(call.call).toMatchObject({ phase: 'ended', reason: 'user_hangup' });
    expect(call.call.utterances.map((utterance: { text: string }) => utterance.text)).toEqual(["What's eating your week?", 'honestly the investor updates, every month I']);
    expect((await followUp(request('http://localhost/api/agent/follow-up', sessionId, { kind: 'call_ended', callId: 'live_call' }, 'http://evil.example'))).status).toBe(403);
  });

  it('records silence after a natural goodbye and lets a failed run retry', async () => {
    const store = createStore(sql);
    const sessionId = await liveCall(store, 'live_bye');
    const events = createVoiceEventHandler(store);
    await events(request('http://localhost/api/voice/event', sessionId, { callId: 'live_bye', kind: 'started' }));
    await events(request('http://localhost/api/voice/event', sessionId, { callId: 'live_bye', kind: 'ended', reason: 'remote_hangup' }));
    let attempts = 0;
    const flaky = createFollowUpHandler(store, async () => { attempts += 1; if (attempts === 1) throw new Error('model down'); return '<silent>'; });
    await expect(flaky(request('http://localhost/api/agent/follow-up', sessionId, { kind: 'call_ended', callId: 'live_bye' }))).rejects.toThrow('model down');
    expect(await (await flaky(request('http://localhost/api/agent/follow-up', sessionId, { kind: 'call_ended', callId: 'live_bye' }))).json()).toEqual({ status: 'silent' });
    const state = projectSession(await store.readEvents(sessionId));
    expect(state.decisions['followup:call:live_bye']).toBe('silent');
    expect(state.messages.filter((message) => message.origin === 'follow_up')).toEqual([]);
  });

  it('marks a call lost when its lease is gone without an end report', async () => {
    const store = createStore(sql);
    const sessionId = await liveCall(store, 'live_lost');
    await store.releaseCallLease(sessionId, 'live_lost');
    const accepted = (await store.readEvents(sessionId)).find((event) => event.id === 'call:live_lost:accepted')!;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const snapshot = await (await createSessionHandler(store)(request('http://localhost/api/session', sessionId, undefined, 'http://localhost', 'GET'))).json();
    expect(snapshot.timeline.find((item: { kind: string }) => item.kind === 'call').call).toMatchObject({ phase: 'dropped', reason: 'lost', endedAt: accepted.at });
    expect(snapshot.pendingFollowUps).toEqual([{ kind: 'call_ended', callId: 'live_lost' }]);
  });

  it('runs voice tool calls with the same evidence gates as text, only for the owning call', async () => {
    const store = createStore(sql);
    const sessionId = await liveCall(store, 'live_tool');
    const stranger = (await getGuestSession(store)).id;
    await createVoiceEventHandler(store)(request('http://localhost/api/voice/event', sessionId, { callId: 'live_tool', kind: 'transcripts', fragments: [{ eventId: 'u1', speaker: 'user', text: "Oh, I'm Dana.", startMs: 0, endMs: 900 }] }));
    const tools = createVoiceToolHandler(store, { OPENAI_API_KEY: 'k', COMPOSIO_API_KEY: 'c', COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'ac' }, { executeRead: async () => { throw new Error('should not read'); } });
    const call = (id: string, body: Record<string, unknown>) => tools(request('http://localhost/api/voice/tool', id, { callId: 'live_tool', callItemId: 'call_1', ...body }));
    expect((await call(stranger, { name: 'remember', arguments: '{}' })).status).toBe(404);
    expect((await call(sessionId, { name: 'send_email', arguments: '{}' })).status).toBe(400);
    const saved = await call(sessionId, { name: 'remember', arguments: JSON.stringify({ key: 'preferred_name', value: 'Dana' }) });
    expect(JSON.parse((await saved.json()).output)).toMatchObject({ status: 'saved', evidence: 'confirmed', provenance: 'user_said' });
    const invented = await tools(request('http://localhost/api/voice/tool', sessionId, { callId: 'live_tool', callItemId: 'call_2', name: 'remember', arguments: JSON.stringify({ key: 'preferred_name', value: 'Jordan' }) }));
    expect(JSON.parse((await invented.json()).output)).toMatchObject({ status: 'rejected' });
    const search = await tools(request('http://localhost/api/voice/tool', sessionId, { callId: 'live_tool', callItemId: 'call_3', name: 'search_gmail', arguments: JSON.stringify({ query: 'in:inbox' }) }));
    expect(JSON.parse((await search.json()).output)).toMatchObject({ status: 'not_connected' });
    const card = await tools(request('http://localhost/api/voice/tool', sessionId, { callId: 'live_tool', callItemId: 'call_4', name: 'show_connection', arguments: JSON.stringify({ toolkit: 'gmail', reason: 'See who is waiting on you' }) }));
    expect(await card.json()).toMatchObject({ ui: { type: 'connection_offer', toolkit: 'gmail' } });
    const state = projectSession(await store.readEvents(sessionId));
    expect(state.onboarding.preferredName).toEqual({ status: 'confirmed', value: 'Dana' });
    expect(state.onboarding.gmail).toBe('offered');
  });

  it('keeps text typed during a call in the thread and lets the user decline a call offer', async () => {
    const store = createStore(sql);
    const sessionId = await liveCall(store, 'live_typed');
    const events = createVoiceEventHandler(store);
    expect((await events(request('http://localhost/api/voice/event', sessionId, { callId: 'live_typed', kind: 'typed', messageId: 'typed-1', text: 'dana@example.com' }))).status).toBe(204);
    expect(projectSession(await store.readEvents(sessionId)).messages.at(-1)).toMatchObject({ id: 'typed-1', speaker: 'user', text: 'dana@example.com' });
    const other = (await getGuestSession(store)).id;
    await store.appendEvent(other, { id: 'call-offer:t1', at: new Date().toISOString(), type: 'call', phase: 'offered' });
    const decline = createCallOfferHandler(store);
    expect((await decline(request('http://localhost/api/voice/offer', other, undefined, 'http://evil.example', 'DELETE'))).status).toBe(403);
    expect((await decline(request('http://localhost/api/voice/offer', other, undefined, 'http://localhost', 'DELETE'))).status).toBe(204);
    const state = projectSession(await store.readEvents(other));
    expect(state.onboarding.call).toBe('declined');
    expect(state.timeline).toContainEqual({ kind: 'call_offer', id: 'call-offer:t1', status: 'declined' });
  });

  it('caps new conversations and calls per client address across cookies, storing only a hash', async () => {
    const store = createStore(sql);
    // The client can put anything first; the proxy appends the real address last.
    const fresh = (ip: string) => new Request('http://localhost/api/session', { headers: { 'x-forwarded-for': `spoofed-${crypto.randomUUID()}, ${ip}` } });
    const handler = createSessionHandler(store);
    const statuses: number[] = [];
    let cookie = '';
    for (let i = 0; i < 31; i++) {
      const response = await handler(fresh('203.0.113.7'));
      statuses.push(response.status);
      cookie ||= (response.headers.get('set-cookie') || '').split(';')[0];
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(30);
    expect(statuses.at(-1)).toBe(429);
    expect((await handler(fresh('203.0.113.8'))).status).toBe(200);
    const rows = await sql`SELECT client_key FROM persona_ip_limits WHERE scope = 'session'`;
    expect(rows.every((row) => /^[0-9a-f]{32}$/.test(row.client_key as string))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('203.0.113');
    const returning = await handler(new Request('http://localhost/api/session', { headers: { 'x-forwarded-for': '203.0.113.7', cookie } }));
    expect(returning.status).toBe(200);
  });

  async function proposed(store: ReturnType<typeof createStore>, sessionId: string, turnId = 'turn-auto') {
    const ctx = {
      store, sessionId, channel: 'text' as const, turnId, state: projectSession(await store.readEvents(sessionId)), userWords: ['every weekday morning please'],
      capabilities: { voice: true, gmail: true, calendar: true }, connected: {}, automations: store,
    };
    const result = await proposeAutomation(ctx, { title: 'Morning inbox rundown', instruction: 'List the emails waiting on my reply, newest first.', cadence: 'weekdays', time: '08:00', toolkits: ['gmail'] });
    expect(result).toMatchObject({ status: 'proposed' });
    const card = projectSession(await store.readEvents(sessionId)).automations.at(-1)!;
    return card.automationId;
  }
  const automationRequest = (sessionId: string, body: Record<string, unknown>) => request('http://localhost/api/automations', sessionId, body);

  it('approves a previewed recurring task in the browser time zone and keeps one active per session', async () => {
    const store = createStore(sql);
    const sessionId = (await getGuestSession(store)).id;
    const id = await proposed(store, sessionId);
    const handler = createAutomationHandler(store, undefined, () => new Date('2026-09-26T16:00:00Z'));
    expect((await handler(automationRequest(sessionId, { action: 'approve', id, timezone: 'Mars/Olympus' }))).status).toBe(400);
    expect((await handler(request('http://localhost/api/automations', sessionId, { action: 'approve', id, timezone: 'America/New_York' }, 'http://evil.example'))).status).toBe(403);
    const approved = await handler(automationRequest(sessionId, { action: 'approve', id, timezone: 'America/New_York' }));
    expect(await approved.json()).toEqual({ status: 'approved', nextRunAt: '2026-09-28T12:00:00.000Z' });
    expect((await handler(automationRequest(sessionId, { action: 'approve', id, timezone: 'America/New_York' }))).status).toBe(409);
    const second = await proposed(store, sessionId, 'turn-auto-2').catch(() => undefined);
    expect(second).toBeUndefined();
    const other = crypto.randomUUID();
    await store.proposeAutomation(sessionId, { id: other, title: 'Second', instruction: 'Another recurring task here.', toolkits: [], cadence: 'daily', time: '09:00' });
    expect(await (await handler(automationRequest(sessionId, { action: 'approve', id: other, timezone: 'America/New_York' }))).json()).toEqual({ status: 'conflict' });
    const state = projectSession(await store.readEvents(sessionId));
    expect(state.onboarding.automation).toEqual({ status: 'active', title: 'Morning inbox rundown', schedule: 'every weekday at 8:00 AM' });
    expect(state.timeline.find((item) => item.kind === 'automation')).toMatchObject({ status: 'active', nextRunAt: '2026-09-28T12:00:00.000Z' });
  });

  it('runs a due occurrence once across two tabs, posts the result, and advances in the user zone', async () => {
    const store = createStore(sql);
    const sessionId = (await getGuestSession(store)).id;
    const id = await proposed(store, sessionId);
    let generated = 0;
    const handler = createAutomationHandler(store, async (_history, _id, trigger) => {
      generated += 1;
      expect(trigger.include).toEqual(['gmail']);
      expect(trigger.instruction).toContain('"List the emails waiting on my reply, newest first."');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'Two threads need you: Dana on the lease (Friday) and Sam about Thursday.';
    });
    const scheduledFor = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 3 * 60_000);
    await store.approveAutomation(sessionId, id, 'America/New_York', scheduledFor);
    const snapshot = await (await createSessionHandler(store)(request('http://localhost/api/session', sessionId, undefined, 'http://localhost', 'GET'))).json();
    expect(snapshot.automationDue).toBe(true);
    const results = await Promise.all([handler(automationRequest(sessionId, { action: 'run_due' })), handler(automationRequest(sessionId, { action: 'run_due' }))]);
    expect((await Promise.all(results.map((response) => response.json()))).map((body) => body.ran).sort()).toEqual([0, 1]);
    expect(generated).toBe(1);
    const state = projectSession(await store.readEvents(sessionId));
    expect(state.messages.filter((message) => message.origin === 'automation').map((message) => message.text)).toEqual(['Two threads need you: Dana on the lease (Friday) and Sam about Thursday.']);
    const expectedNext = nextRun({ cadence: 'weekdays', time: '08:00' }, 'America/New_York', new Date()).toISOString();
    expect((await store.getAutomation(sessionId, id))?.nextRunAt).toBe(expectedNext);
    expect(state.timeline.find((item) => item.kind === 'automation')).toMatchObject({ status: 'active', nextRunAt: expectedNext });
    const runs = await sql`SELECT trigger, status, message_event_id FROM persona_automation_runs WHERE automation_id = ${id}`;
    expect(runs).toEqual([{ trigger: 'schedule', status: 'succeeded', message_event_id: `answer:automation:${id}:${scheduledFor.toISOString()}:schedule` }]);
    const runNow = await handler(automationRequest(sessionId, { action: 'run_now', id }));
    expect(await runNow.json()).toMatchObject({ status: 'ran', message: { role: 'assistant' } });
    expect((await store.getAutomation(sessionId, id))?.nextRunAt).toBe(expectedNext);
    expect((await handler(automationRequest(sessionId, { action: 'disable', id }))).status).toBe(200);
    expect((await handler(automationRequest(sessionId, { action: 'run_now', id }))).status).toBe(409);
    expect(projectSession(await store.readEvents(sessionId)).onboarding.automation.status).toBe('disabled');
  });

  it('records a failed run without claiming anything happened, and the cron entry point needs its secret', async () => {
    const store = createStore(sql);
    const sessionId = (await getGuestSession(store)).id;
    const id = await proposed(store, sessionId);
    await store.approveAutomation(sessionId, id, 'Europe/London', new Date(Date.now() - 60_000));
    const runner = createDueRunner(store, async () => { throw new Error('model down'); }, 'cron-secret');
    expect((await runner(new Request('http://localhost/api/automations/run-due'))).status).toBe(404);
    expect((await runner(new Request('http://localhost/api/automations/run-due', { headers: { authorization: 'Bearer wrong' } }))).status).toBe(404);
    const response = await runner(new Request('http://localhost/api/automations/run-due', { headers: { authorization: 'Bearer cron-secret' } }));
    expect(await response.json()).toMatchObject({ ran: 0 });
    const state = projectSession(await store.readEvents(sessionId));
    expect(state.timeline.some((item) => item.kind === 'automation_notice')).toBe(true);
    expect(state.messages.some((message) => message.origin === 'automation')).toBe(false);
    const [run] = await sql`SELECT status, error FROM persona_automation_runs WHERE automation_id = ${id}`;
    expect(run).toEqual({ status: 'failed', error: 'model down' });
    expect(Date.parse((await store.getAutomation(sessionId, id))!.nextRunAt!)).toBeGreaterThan(Date.now());
  });

  it('lets a crashed follow-up be retried once its lease expires', async () => {
    const store = createStore(sql);
    const sessionId = (await getGuestSession(store)).id;
    expect(await store.reserve(sessionId, 'followup:x')).toBe(true);
    expect(await store.reserve(sessionId, 'followup:x')).toBe(false);
    await sql`UPDATE persona_reservations SET created_at = now() - interval '10 minutes' WHERE session_id = ${sessionId}`;
    expect(await store.reserve(sessionId, 'followup:x')).toBe(true);
    expect(await store.reserve(sessionId, 'followup:x')).toBe(false);
  });

  it('keeps ended calls ended: no late start, no typing, no stale transcripts', async () => {
    const store = createStore(sql);
    const sessionId = await liveCall(store, 'live_done');
    const events = createVoiceEventHandler(store);
    const post = (body: Record<string, unknown>) => events(request('http://localhost/api/voice/event', sessionId, { callId: 'live_done', ...body }));
    expect((await post({ kind: 'ended', reason: 'user_hangup' })).status).toBe(204);
    expect((await post({ kind: 'started' })).status).toBe(204);
    expect(projectSession(await store.readEvents(sessionId)).calls[0]).toMatchObject({ phase: 'ended', reason: 'user_hangup' });
    expect((await post({ kind: 'typed', messageId: 'late', text: 'hello?' })).status).toBe(409);
    expect((await post({ kind: 'transcripts', fragments: [{ eventId: 'tail', speaker: 'user', text: 'bye', startMs: 10, endMs: 20 }] })).status).toBe(204);
    await sql`UPDATE persona_events SET payload = jsonb_set(payload, '{at}', to_jsonb((now() - interval '5 minutes')::text)) WHERE session_id = ${sessionId} AND event_id = 'call:live_done:ended'`;
    expect((await post({ kind: 'transcripts', fragments: [{ eventId: 'stale', speaker: 'user', text: 'spam', startMs: 30, endMs: 40 }] })).status).toBe(409);
  });

  it('records an automation run with no answer as failed rather than "nothing new"', async () => {
    const store = createStore(sql);
    const sessionId = (await getGuestSession(store)).id;
    const id = await proposed(store, sessionId);
    await store.approveAutomation(sessionId, id, 'America/New_York', new Date(Date.now() - 60_000));
    const handler = createAutomationHandler(store, async () => '   ');
    expect(await (await handler(automationRequest(sessionId, { action: 'run_due' }))).json()).toMatchObject({ ran: 0 });
    const state = projectSession(await store.readEvents(sessionId));
    expect(state.messages.some((message) => message.origin === 'automation')).toBe(false);
    expect(state.timeline.some((item) => item.kind === 'automation_notice')).toBe(true);
    expect(state.timeline.find((item) => item.kind === 'automation')).toMatchObject({ status: 'active', nextRunAt: expect.any(String) });
  });
});
