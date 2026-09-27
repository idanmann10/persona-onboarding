import type { SessionEvent } from '../domain/events';
import { readSessionCookie } from './session';

interface Store {
  sessionExists(id: string): Promise<boolean>;
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
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
    const history = await store.readEvents(sessionId);
    if (!history.some((event) => event.id === `call:${body.callId}:accepted`)) return new Response('Call not found', { status: 404 });
    const at = new Date().toISOString();
    let event: SessionEvent;
    if (body.kind === 'started' || body.kind === 'ended' || body.kind === 'dropped') {
      event = { id: `call:${body.callId}:${body.kind}`, at, type: 'call', phase: body.kind, callId: body.callId };
    } else if (body.kind === 'transcript') {
      const validTime = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3_600_000;
      if (typeof body.eventId !== 'string' || !/^[\w:-]{1,100}$/.test(body.eventId) ||
          (body.speaker !== 'user' && body.speaker !== 'assistant') || typeof body.text !== 'string' || !body.text || body.text.length > 500 ||
          !validTime(body.startMs) || !validTime(body.endMs) || (body.endMs as number) < (body.startMs as number)) {
        return new Response('Invalid transcript fragment', { status: 400 });
      }
      event = { id: `voice:${body.callId}:${body.eventId}`, at, type: 'voice_fragment', callId: body.callId, speaker: body.speaker, text: body.text, startMs: body.startMs as number, endMs: body.endMs as number, final: false };
    } else return new Response('Invalid event kind', { status: 400 });
    await store.appendEvent(sessionId, event);
    return new Response(null, { status: 204 });
  };
}
