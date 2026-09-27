import type { SessionEvent } from '../domain/events';
import { projectSession, type SessionProjection } from '../domain/project';
import type { FollowUpRequest } from '../agent/follow-up';
import { getGuestSession } from '../agent/session';
import { withinIpLimit, type IpQuotaStore } from './client-key';
import type { AutomationRecord } from '../domain/automation';
import { personaSettings } from '../domain/persona';

/** A page load this long after the last activity counts as coming back. */
const VISIT_GAP_MS = 30 * 60_000;

interface Store extends IpQuotaStore {
  createSession(id: string): Promise<void>;
  sessionExists(id: string): Promise<boolean>;
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  getCallLease?(id: string): Promise<{ callId?: string; active: boolean } | undefined>;
  listAutomations?(id: string): Promise<AutomationRecord[]>;
  getSessionAccount?(id: string): Promise<{ email: string } | undefined>;
}

export function readSessionCookie(request: Request): string | undefined {
  return request.headers.get('cookie')?.match(/(?:^|;\s*)persona_session=([^;]+)/)?.[1];
}

const FOLLOW_UP_WINDOW_MS = 24 * 3_600_000;

/**
 * Follow-ups still owed: a call or connection whose assistant reaction never ran, for example because
 * the tab closed during the call. The client asks for them on load; the server decides what to say.
 */
export function pendingFollowUps(state: SessionProjection, now = Date.now()): FollowUpRequest[] {
  const pending: FollowUpRequest[] = [];
  for (const call of state.calls) {
    if ((call.phase === 'ended' || call.phase === 'dropped') && !state.decisions[`followup:call:${call.callId}`] &&
        call.endedAt && now - Date.parse(call.endedAt) < FOLLOW_UP_WINDOW_MS) pending.push({ kind: 'call_ended', callId: call.callId });
  }
  for (const toolkit of ['gmail', 'calendar'] as const) {
    const notice = [...state.timeline].reverse().find((item) => item.kind === 'connection_notice' && item.toolkit === toolkit);
    if (notice && notice.kind === 'connection_notice' && notice.phase !== 'disconnected' && !state.decisions[`followup:${notice.id}`] &&
        (!notice.at || now - Date.parse(notice.at) < FOLLOW_UP_WINDOW_MS)) pending.push({ kind: 'connection', toolkit });
  }
  return pending;
}

export function createSessionHandler(store: Store, env: Record<string, string | undefined> = {}) {
  return async (request: Request): Promise<Response> => {
    const cookie = readSessionCookie(request);
    const known = Boolean(cookie && /^[0-9a-f-]{36}$/i.test(cookie) && await store.sessionExists(cookie));
    if (!known && !(await withinIpLimit(store, request, 'session'))) return new Response('Too many new conversations from this network. Try again later.', { status: 429 });
    const session = await getGuestSession(store, cookie);
    let events = session.events;
    const state = projectSession(events);
    const live = state.calls.find((call) => call.phase === 'accepted' || call.phase === 'started');
    if (live && store.getCallLease) {
      const lease = await store.getCallLease(session.id);
      if (!lease?.active || lease.callId !== live.callId) {
        // Date the loss at the call's last sign of life, not at this page load, which may be days later.
        const at = live.lastActivityAt ?? live.startedAt ?? new Date().toISOString();
        await store.appendEvent(session.id, { id: `call:${live.callId}:dropped`, at, type: 'call', phase: 'dropped', callId: live.callId, reason: 'lost' });
        events = await store.readEvents(session.id);
      }
    }
    const lastActivity = Math.max(0, ...events.map((event) => Date.parse(event.at) || 0));
    if (!session.created && lastActivity && Date.now() - lastActivity > VISIT_GAP_MS) {
      const at = new Date().toISOString();
      await store.appendEvent(session.id, { id: `visit:${at}`, at, type: 'visit' });
      events = await store.readEvents(session.id);
    }
    const projection = events === session.events ? state : projectSession(events);
    const messages = events
      .filter((event): event is Extract<SessionEvent, { type: 'message' }> => event.type === 'message')
      .map((event) => ({ id: event.id, role: event.speaker, text: event.text }));
    const voiceFragments = events
      .filter((event): event is Extract<SessionEvent, { type: 'voice_fragment' }> => event.type === 'voice_fragment')
      .map((event) => ({ speaker: event.speaker, text: event.text, startMs: event.startMs, endMs: event.endMs, callId: event.callId }));
    const headers = new Headers({ 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
    if (session.created) {
      const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
      headers.set('Set-Cookie', `persona_session=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
    }
    const automations = store.listAutomations ? await store.listAutomations(session.id) : [];
    const automationDue = automations.some((automation) => automation.status === 'active' && automation.nextRunAt && Date.parse(automation.nextRunAt) <= Date.now());
    const account = store.getSessionAccount ? await store.getSessionAccount(session.id) : undefined;
    return new Response(JSON.stringify({
      messages, voiceFragments, timeline: projection.timeline, progress: projection.onboarding, settings: personaSettings(projection, env.OPENAI_VOICE),
      pendingFollowUps: pendingFollowUps(projection), automationDue, account: account ? { email: account.email } : null,
    }), { headers });
  };
}
