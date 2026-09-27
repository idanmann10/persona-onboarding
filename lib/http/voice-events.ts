import type { CallEndReason, SessionEvent } from '../domain/events';
import { readSessionCookie } from './session';
import { withinIpLimit, type IpQuotaStore } from './client-key';

interface Store extends IpQuotaStore {
  sessionExists(id: string): Promise<boolean>;
  hasEvent(id: string, eventId: string): Promise<boolean>;
  getEvent?(id: string, eventId: string): Promise<SessionEvent | undefined>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  releaseCallLease(id: string, callId: string): Promise<void>;
  refreshCallLease(id: string, callId: string): Promise<boolean>;
}

/** End reasons a browser may report; `lost` is only ever inferred by the server. */
const CLIENT_REASONS = new Set<CallEndReason>(['user_hangup', 'remote_hangup', 'connection_lost', 'inactive', 'max_duration', 'expired', 'content', 'page_closed', 'setup_failed']);
const MAX_BATCH = 40;
/** Fragments may trail an end report by a moment (a page-close beacon races its last flush). */
const TRAILING_FRAGMENTS_MS = 60_000;

type Fragment = { eventId: string; speaker: 'user' | 'assistant'; text: string; startMs: number; endMs: number };

function parseFragment(value: unknown): Fragment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const body = value as Record<string, unknown>;
  const validTime = (time: unknown) => typeof time === 'number' && Number.isFinite(time) && time >= 0 && time <= 3_600_000;
  if (typeof body.eventId !== 'string' || !/^[\w:-]{1,100}$/.test(body.eventId) ||
      (body.speaker !== 'user' && body.speaker !== 'assistant') || typeof body.text !== 'string' || !body.text || body.text.length > 500 ||
      !validTime(body.startMs) || !validTime(body.endMs) || (body.endMs as number) < (body.startMs as number)) return undefined;
  return { eventId: body.eventId, speaker: body.speaker, text: body.text, startMs: body.startMs as number, endMs: body.endMs as number };
}

export function createVoiceEventHandler(store: Store) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Unexpected origin', { status: 403 });
    const sessionId = readSessionCookie(request);
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId) || !(await store.sessionExists(sessionId))) return new Response('Session required', { status: 401 });
    let payload: unknown;
    try { payload = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (!payload || typeof payload !== 'object') return new Response('Invalid event', { status: 400 });
    const body = payload as Record<string, unknown>;
    if (typeof body.callId !== 'string' || !/^live_[\w-]{1,100}$/.test(body.callId)) return new Response('Invalid call ID', { status: 400 });
    const callId = body.callId;
    if (!(await store.hasEvent(sessionId, `call:${callId}:accepted`))) return new Response('Call not found', { status: 404 });
    if (body.kind === 'heartbeat') return new Response(null, { status: await store.refreshCallLease(sessionId, callId) ? 204 : 409 });
    if (!(await withinIpLimit(store, request, 'voice_event'))) return new Response('Too many call events', { status: 429 });
    const ended = (await store.getEvent?.(sessionId, `call:${callId}:ended`)) ?? (await store.getEvent?.(sessionId, `call:${callId}:dropped`));
    const endedMs = ended ? Date.parse(ended.at) : undefined;
    const at = new Date().toISOString();
    const fragmentEvent = (fragment: Fragment): SessionEvent => ({ id: `voice:${callId}:${fragment.eventId}`, at, type: 'voice_fragment', callId, speaker: fragment.speaker, text: fragment.text, startMs: fragment.startMs, endMs: fragment.endMs, final: false });
    if ((body.kind === 'transcripts' || body.kind === 'transcript') && endedMs !== undefined && Date.now() - endedMs > TRAILING_FRAGMENTS_MS) {
      return new Response('Call has ended', { status: 409 });
    }
    if (body.kind === 'transcripts') {
      if (!Array.isArray(body.fragments) || !body.fragments.length || body.fragments.length > MAX_BATCH) return new Response('Invalid transcript batch', { status: 400 });
      const fragments = body.fragments.map(parseFragment);
      if (fragments.some((fragment) => !fragment)) return new Response('Invalid transcript fragment', { status: 400 });
      for (const fragment of fragments as Fragment[]) await store.appendEvent(sessionId, fragmentEvent(fragment));
      return new Response(null, { status: 204 });
    }
    if (body.kind === 'transcript') {
      const fragment = parseFragment(body);
      if (!fragment) return new Response('Invalid transcript fragment', { status: 400 });
      await store.appendEvent(sessionId, fragmentEvent(fragment));
      return new Response(null, { status: 204 });
    }
    if (body.kind === 'typed' && ended) return new Response('Call has ended', { status: 409 });
    if (body.kind === 'typed') {
      if (typeof body.messageId !== 'string' || !/^[\w:-]{1,100}$/.test(body.messageId) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2_000) {
        return new Response('Invalid typed message', { status: 400 });
      }
      await store.appendEvent(sessionId, { id: body.messageId, at, type: 'message', speaker: 'user', channel: 'text', text: body.text.trim() });
      return new Response(null, { status: 204 });
    }
    // A late "started" must not bring an ended call back to life.
    if (body.kind === 'started' && ended) return new Response(null, { status: 204 });
    if (body.kind === 'started' || body.kind === 'ended' || body.kind === 'dropped') {
      const reason = typeof body.reason === 'string' && CLIENT_REASONS.has(body.reason as CallEndReason) ? body.reason as CallEndReason : undefined;
      if (body.kind !== 'started' && await store.hasEvent(sessionId, `call:${callId}:${body.kind === 'ended' ? 'dropped' : 'ended'}`)) {
        await store.releaseCallLease(sessionId, callId);
        return new Response(null, { status: 204 });
      }
      await store.appendEvent(sessionId, { id: `call:${callId}:${body.kind}`, at, type: 'call', phase: body.kind, callId, ...(body.kind !== 'started' && reason ? { reason } : {}) });
      if (body.kind !== 'started') await store.releaseCallLease(sessionId, callId);
      return new Response(null, { status: 204 });
    }
    return new Response('Invalid event kind', { status: 400 });
  };
}
