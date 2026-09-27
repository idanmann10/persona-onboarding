import type { SessionEvent } from '../domain/events';
import { runTextTurn } from '../agent/chat';
import { readSessionCookie } from './session';

interface Store {
  sessionExists(id: string): Promise<boolean>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  readEvents(id: string): Promise<SessionEvent[]>;
  consumeQuota(id: string, scope: 'chat', limit: number, windowSeconds: number): Promise<boolean>;
}

export function createChatHandler(store: Store, respond: (history: SessionEvent[], sessionId: string) => AsyncIterable<string>) {
  return async (request: Request): Promise<Response> => {
    const sessionId = readSessionCookie(request);
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId) || !(await store.sessionExists(sessionId))) {
      return new Response('Session required', { status: 401 });
    }
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Origin mismatch', { status: 403 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (!body || typeof body !== 'object') return new Response('Invalid message', { status: 400 });
    const { id, text } = body as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[\w:-]{1,100}$/.test(id) || typeof text !== 'string' || !text.trim() || text.length > 8000) {
      return new Response('Invalid message', { status: 400 });
    }
    const existingAnswer = (await store.readEvents(sessionId)).some((event) => event.id === `answer:${id}`);
    if (!existingAnswer && !(await store.consumeQuota(sessionId, 'chat', 12, 60))) return new Response('Too many messages; try again shortly', { status: 429 });
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
    return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  };
}
