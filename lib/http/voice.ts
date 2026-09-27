import type { SessionEvent } from '../domain/events';
import { readSessionCookie } from './session';
import { projectSession } from '../domain/project';
import { availableCapabilities } from '../domain/capabilities';
import { buildLiveSession } from '../voice/session-config';

interface Store {
  sessionExists(id: string): Promise<boolean>;
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  acquireCallLease(id: string, leaseId: string): Promise<boolean>;
  bindCallLease(id: string, leaseId: string, callId: string): Promise<boolean>;
  releaseCallLease(id: string, leaseOrCallId: string): Promise<void>;
  consumeQuota(id: string, scope: 'voice', limit: number, windowSeconds: number): Promise<boolean>;
}

export function createVoiceSessionHandler(store: Store, key: string, upstream: typeof fetch, env: Record<string, string | undefined> = {}) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Unexpected origin', { status: 403 });
    const sessionId = readSessionCookie(request);
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId) || !(await store.sessionExists(sessionId))) return new Response('Session required', { status: 401 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const sdp = body && typeof body === 'object' && 'sdp' in body ? (body as { sdp: unknown }).sdp : undefined;
    if (typeof sdp !== 'string' || !sdp.trim() || sdp.length > 65_536) return new Response('Invalid SDP offer', { status: 400 });
    const leaseId = crypto.randomUUID();
    if (!(await store.acquireCallLease(sessionId, leaseId))) return new Response('A call is already active', { status: 409 });
    if (!(await store.consumeQuota(sessionId, 'voice', 3, 600))) {
      await store.releaseCallLease(sessionId, leaseId);
      return new Response('Call limit reached; try again later', { status: 429 });
    }
    const state = projectSession(await store.readEvents(sessionId));
    const capabilities = availableCapabilities(env);
    const { session, greeting, limits, delegation } = buildLiveSession(state, env, { gmail: capabilities.gmail, calendar: capabilities.calendar });
    let result: Response;
    try {
      result = await upstream('https://api.openai.com/v1/live/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, transport: { type: 'webrtc', sdp } }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch { await store.releaseCallLease(sessionId, leaseId); return new Response('Voice connection failed', { status: 502 }); }
    if (!result.ok) {
      console.error('GPT-Live session rejected', result.status, (await result.text().catch(() => '')).slice(0, 500));
      await store.releaseCallLease(sessionId, leaseId);
      return new Response('Voice connection failed', { status: 502 });
    }
    const payload = await result.json() as { session?: { id?: unknown }; transport?: { type?: unknown; sdp?: unknown } };
    if (typeof payload.session?.id !== 'string' || payload.transport?.type !== 'webrtc' || typeof payload.transport.sdp !== 'string') {
      await store.releaseCallLease(sessionId, leaseId);
      return new Response('Invalid voice response', { status: 502 });
    }
    if (!(await store.bindCallLease(sessionId, leaseId, payload.session.id))) return new Response('Call lease expired', { status: 409 });
    await store.appendEvent(sessionId, { id: `call:${payload.session.id}:accepted`, at: new Date().toISOString(), type: 'call', phase: 'accepted', callId: payload.session.id });
    return Response.json({ session: { id: payload.session.id }, transport: { type: 'webrtc', sdp: payload.transport.sdp }, greeting, limits, delegation }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  };
}
