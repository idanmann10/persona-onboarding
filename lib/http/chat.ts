import type { SessionEvent } from '../domain/events';
import { isValidTimeZone } from '../domain/schedule';
import { runTextTurn } from '../agent/chat';
import { signedInSession, type LoginStore } from '../auth/login';
import { withinIpLimit, type IpQuotaStore } from './client-key';

interface Store extends IpQuotaStore, LoginStore {
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  readEvents(id: string): Promise<SessionEvent[]>;
  consumeQuota(id: string, scope: 'chat', limit: number, windowSeconds: number): Promise<boolean>;
}

/** The browser's zone gives the assistant their local time when sign-in didn't provide one. */
export async function rememberBrowserZone(store: Pick<Store, 'appendEvent'>, sessionId: string, history: SessionEvent[], timezone: unknown): Promise<void> {
  if (typeof timezone !== 'string' || !isValidTimeZone(timezone) || history.some((event) => event.type === 'fact' && event.key === 'timezone')) return;
  await store.appendEvent(sessionId, { id: 'fact:timezone:browser', at: new Date().toISOString(), type: 'fact', key: 'timezone', value: timezone, evidence: 'tentative', provenance: 'tool_observed', sourceEventId: 'browser' });
}

/**
 * POST /api/chat {id, text, timezone?}: one user message and the streamed reply. `afterTurn` is handed
 * the turn so the route can run the background agents once the stream has finished (Next's `after`).
 */
export function createChatHandler(store: Store, respond: (history: SessionEvent[], sessionId: string) => AsyncIterable<string>, afterTurn?: (sessionId: string, userEventId: string) => void) {
  return async (request: Request): Promise<Response> => {
    const sessionId = await signedInSession(store, request);
    if (!sessionId) {
      return new Response('Session required', { status: 401 });
    }
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Origin mismatch', { status: 403 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (!body || typeof body !== 'object') return new Response('Invalid message', { status: 400 });
    const { id, text, timezone } = body as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[\w:-]{1,100}$/.test(id) || typeof text !== 'string' || !text.trim() || text.length > 8000) {
      return new Response('Invalid message', { status: 400 });
    }
    const history = await store.readEvents(sessionId);
    const existingAnswer = history.some((event) => event.id === `answer:${id}`);
    if (!existingAnswer && (!(await store.consumeQuota(sessionId, 'chat', 12, 60)) || !(await withinIpLimit(store, request, 'chat')))) return new Response('Too many messages; try again shortly', { status: 429 });
    await rememberBrowserZone(store, sessionId, history, timezone);
    const event: SessionEvent = { id, at: new Date().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: text.trim() };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of runTextTurn(store, sessionId, event, (history) => respond(history, sessionId))) controller.enqueue(encoder.encode(chunk));
          controller.close();
        } catch (error) { controller.error(error); }
      },
    });
    if (!existingAnswer) afterTurn?.(sessionId, id);
    return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  };
}
