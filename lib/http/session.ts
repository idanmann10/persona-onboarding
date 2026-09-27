import type { SessionEvent } from '../domain/events';
import { getGuestSession } from '../agent/session';

interface Store {
  createSession(id: string): Promise<void>;
  sessionExists(id: string): Promise<boolean>;
  readEvents(id: string): Promise<SessionEvent[]>;
}

export function readSessionCookie(request: Request): string | undefined {
  return request.headers.get('cookie')?.match(/(?:^|;\s*)persona_session=([^;]+)/)?.[1];
}

export function createSessionHandler(store: Store) {
  return async (request: Request): Promise<Response> => {
    const session = await getGuestSession(store, readSessionCookie(request));
    const messages = session.events
      .filter((event): event is Extract<SessionEvent, { type: 'message' }> => event.type === 'message')
      .map((event) => ({ id: event.id, role: event.speaker, text: event.text }));
    const voiceFragments = session.events
      .filter((event): event is Extract<SessionEvent, { type: 'voice_fragment' }> => event.type === 'voice_fragment')
      .map((event) => ({ speaker: event.speaker, text: event.text, startMs: event.startMs, endMs: event.endMs, callId: event.callId }));
    const headers = new Headers({ 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
    if (session.created) {
      const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
      headers.set('Set-Cookie', `persona_session=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
    }
    return new Response(JSON.stringify({ messages, voiceFragments }), { headers });
  };
}
