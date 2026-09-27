import type { SessionEvent } from '../domain/events';
import { readSessionCookie } from './session';

interface Store {
  sessionExists(id: string): Promise<boolean>;
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
}

export function createVoiceSessionHandler(store: Store, key: string, upstream: typeof fetch) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Unexpected origin', { status: 403 });
    const sessionId = readSessionCookie(request);
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId) || !(await store.sessionExists(sessionId))) return new Response('Session required', { status: 401 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const sdp = body && typeof body === 'object' && 'sdp' in body ? (body as { sdp: unknown }).sdp : undefined;
    if (typeof sdp !== 'string' || !sdp.trim() || sdp.length > 65_536) return new Response('Invalid SDP offer', { status: 400 });
    const history = (await store.readEvents(sessionId))
      .filter((event): event is Extract<SessionEvent, { type: 'message' }> => event.type === 'message')
      .slice(-20);
    const currentTask = history.filter((event) => event.speaker === 'user').at(-1)?.text;
    const session = {
      model: 'gpt-live-1',
      instructions: `You are Persona in a browser voice call. Continue the existing conversation. Be concise and kind. The current task is: ${currentTask || 'Listen to the user.'} Do not force onboarding. Treat uncertain identity and partial transcripts as unverified. Do not claim any account action was completed; no account tools are available in this call. The user may hang up or switch to text at any time.`,
      input: history.map((event) => ({ type: 'message', role: event.speaker, content: [{ type: event.speaker === 'user' ? 'input_text' : 'output_text', text: event.text }] })),
    };
    let result: Response;
    try {
      result = await upstream('https://api.openai.com/v1/live/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, transport: { type: 'webrtc', sdp } }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch { return new Response('Voice connection failed', { status: 502 }); }
    if (!result.ok) return new Response('Voice connection failed', { status: 502 });
    const payload = await result.json() as { session?: { id?: unknown }; transport?: { type?: unknown; sdp?: unknown } };
    if (typeof payload.session?.id !== 'string' || payload.transport?.type !== 'webrtc' || typeof payload.transport.sdp !== 'string') {
      return new Response('Invalid voice response', { status: 502 });
    }
    await store.appendEvent(sessionId, { id: `call:${payload.session.id}:accepted`, at: new Date().toISOString(), type: 'call', phase: 'accepted' });
    return Response.json({ session: { id: payload.session.id }, transport: { type: 'webrtc', sdp: payload.transport.sdp } }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  };
}
