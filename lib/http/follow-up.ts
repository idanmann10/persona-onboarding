import type { SessionEvent } from '../domain/events';
import { projectSession } from '../domain/project';
import { describeTrigger, isSilent, type FollowUpRequest } from '../agent/follow-up';
import type { TurnTrigger } from '../agent/turn';
import { readSessionCookie } from './session';

interface Store {
  sessionExists(id: string): Promise<boolean>;
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  reserve(id: string, key: string): Promise<boolean>;
  releaseReservation(id: string, key: string): Promise<void>;
  consumeQuota(id: string, scope: 'chat', limit: number, windowSeconds: number): Promise<boolean>;
}

function parseRequest(body: unknown): (FollowUpRequest & { acknowledge?: boolean }) | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = body as Record<string, unknown>;
  if (value.kind === 'call_ended' && typeof value.callId === 'string' && /^live_[\w-]{1,100}$/.test(value.callId)) return { kind: 'call_ended', callId: value.callId };
  if (value.kind === 'connection' && (value.toolkit === 'gmail' || value.toolkit === 'calendar')) return { kind: 'connection', toolkit: value.toolkit, acknowledge: value.acknowledge === true };
  return undefined;
}

function recorded(history: SessionEvent[], trigger: TurnTrigger): Response | undefined {
  const decision = history.find((event) => event.id === `decision:${trigger.id}`);
  if (!decision || decision.type !== 'decision') return undefined;
  const message = history.find((event) => event.id === `answer:${trigger.id}`);
  return message?.type === 'message'
    ? Response.json({ status: 'messaged', message: { id: message.id, role: 'assistant', text: message.text } })
    : Response.json({ status: 'silent' });
}

/**
 * Wake the assistant after an app event (a call ended, an account connected). The trigger is derived
 * from durable server state, never from client text; each trigger runs at most once per session, and
 * the assistant may decide to stay silent.
 */
export function createFollowUpHandler(store: Store, run: (history: SessionEvent[], sessionId: string, trigger: TurnTrigger) => Promise<string>) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Unexpected origin', { status: 403 });
    const sessionId = readSessionCookie(request);
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId) || !(await store.sessionExists(sessionId))) return new Response('Session required', { status: 401 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const parsed = parseRequest(body);
    if (!parsed) return new Response('Invalid follow-up', { status: 400 });
    const history = await store.readEvents(sessionId);
    const trigger = describeTrigger(projectSession(history), parsed);
    if (!trigger) return Response.json({ status: 'not_ready' }, { status: 409 });
    const existing = recorded(history, trigger);
    if (existing) return existing;
    if (parsed.kind === 'connection' && parsed.acknowledge) {
      // Handled live on a call: record that no text follow-up is owed.
      if (await store.reserve(sessionId, trigger.id)) await store.appendEvent(sessionId, { id: `decision:${trigger.id}`, at: new Date().toISOString(), type: 'decision', trigger: trigger.id, outcome: 'silent' });
      return Response.json({ status: 'silent' });
    }
    if (!(await store.consumeQuota(sessionId, 'chat', 12, 60))) return new Response('Too many requests; try again shortly', { status: 429 });
    if (!(await store.reserve(sessionId, trigger.id))) return Response.json({ status: 'pending' }, { status: 202 });
    let text: string;
    try { text = await run(history, sessionId, trigger); }
    catch (error) {
      await store.releaseReservation(sessionId, trigger.id);
      throw error;
    }
    const at = new Date().toISOString();
    if (isSilent(text)) {
      await store.appendEvent(sessionId, { id: `decision:${trigger.id}`, at, type: 'decision', trigger: trigger.id, outcome: 'silent' });
      return Response.json({ status: 'silent' });
    }
    const message: SessionEvent = { id: `answer:${trigger.id}`, at, type: 'message', speaker: 'assistant', channel: 'text', text: text.trim(), origin: 'follow_up' };
    await store.appendEvent(sessionId, message);
    await store.appendEvent(sessionId, { id: `decision:${trigger.id}`, at, type: 'decision', trigger: trigger.id, outcome: 'messaged' });
    return Response.json({ status: 'messaged', message: { id: message.id, role: 'assistant', text: message.text } });
  };
}
