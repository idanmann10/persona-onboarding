import { signedInSession, type LoginStore } from '../auth/login';

/**
 * POST /api/agent/greeting: the assistant's first message, streamed, for a conversation that has none.
 * 'exists' (200) when it's already written, 'pending' (202) while another tab writes it: the page then
 * waits for it through /api/agent/updates.
 */
export function createGreetingHandler(store: LoginStore, open: (sessionId: string) => Promise<'exists' | 'pending' | AsyncGenerator<string>>) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Unexpected origin', { status: 403 });
    const sessionId = await signedInSession(store, request);
    if (!sessionId) return new Response('Session required', { status: 401 });
    const opened = await open(sessionId);
    if (opened === 'exists') return Response.json({ status: 'exists' });
    if (opened === 'pending') return Response.json({ status: 'pending' }, { status: 202 });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of opened) controller.enqueue(encoder.encode(chunk));
          controller.close();
        } catch (error) { controller.error(error); }
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  };
}
