import type { SessionEvent } from '../domain/events';
import { signedInSession, type LoginStore } from '../auth/login';
import { projectSession } from '../domain/project';
import { availableCapabilities } from '../domain/capabilities';
import { buildLiveSession } from '../voice/session-config';
import { withinIpLimit, type IpQuotaStore } from './client-key';
import { recordTrace, type TraceEntry, type TraceSink } from '../observability/trace';
import { sameOrigin } from './origin';

interface Store extends IpQuotaStore, LoginStore {
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  acquireCallLease(id: string, leaseId: string): Promise<boolean>;
  bindCallLease(id: string, leaseId: string, callId: string): Promise<boolean>;
  releaseCallLease(id: string, leaseOrCallId: string): Promise<void>;
  consumeQuota(id: string, scope: 'voice', limit: number, windowSeconds: number): Promise<boolean>;
  appendTrace?: TraceSink['appendTrace'];
}

export function createVoiceSessionHandler(store: Store, key: string, upstream: typeof fetch, env: Record<string, string | undefined> = {}) {
  return async (request: Request): Promise<Response> => {
    if (!sameOrigin(request)) return new Response('Unexpected origin', { status: 403 });
    const sessionId = await signedInSession(store, request);
    if (!sessionId) return new Response('Session required', { status: 401 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const sdp = body && typeof body === 'object' && 'sdp' in body ? (body as { sdp: unknown }).sdp : undefined;
    if (typeof sdp !== 'string' || !sdp.trim() || sdp.length > 65_536) return new Response('Invalid SDP offer', { status: 400 });
    if (!(await withinIpLimit(store, request, 'voice'))) return new Response('Call limit reached; try again later', { status: 429 });
    const leaseId = crypto.randomUUID();
    if (!(await store.acquireCallLease(sessionId, leaseId))) return new Response('A call is already active', { status: 409 });
    if (!(await store.consumeQuota(sessionId, 'voice', 3, 600))) {
      await store.releaseCallLease(sessionId, leaseId);
      return new Response('Call limit reached; try again later', { status: 429 });
    }
    const state = projectSession(await store.readEvents(sessionId));
    const capabilities = availableCapabilities(env);
    const { session, greeting, greetingLine, limits, delegation } = buildLiveSession(state, env, { gmail: capabilities.gmail, calendar: capabilities.calendar });
    const setupStarted = Date.now();
    const described = session as { model?: string; instructions?: string; input?: unknown[]; audio?: { output?: { voice?: string } } };
    // The agent log's record of the setup: which voice and model, what it was seeded with, how long GPT-Live took.
    const setup = (callId: string, status: 'ok' | 'error', extra: Record<string, unknown> = {}): Promise<void> => recordTrace(store, sessionId, {
      turnId: callId, kind: 'call', name: 'Call setup', at: new Date().toISOString(), durationMs: Date.now() - setupStarted, status,
      data: {
        model: described.model ?? 'gpt-live-1', voice: described.audio?.output?.voice, delegation: delegation ? 'on' : 'off',
        instructionsChars: described.instructions?.length ?? 0, seededMessages: described.input?.length ?? 0, ...extra,
      },
    } satisfies TraceEntry);
    let result: Response;
    try {
      result = await upstream('https://api.openai.com/v1/live/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, transport: { type: 'webrtc', sdp } }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      await Promise.all([store.releaseCallLease(sessionId, leaseId), setup(`call-setup:${leaseId}`, 'error', { error: error instanceof Error && error.name === 'TimeoutError' ? 'GPT-Live did not answer in 20s' : 'GPT-Live unreachable' })]);
      return new Response('Voice connection failed', { status: 502 });
    }
    if (!result.ok) {
      console.error('GPT-Live session rejected', result.status, (await result.text().catch(() => '')).slice(0, 500));
      await Promise.all([store.releaseCallLease(sessionId, leaseId), setup(`call-setup:${leaseId}`, 'error', { error: `GPT-Live rejected the session (${result.status})` })]);
      return new Response('Voice connection failed', { status: 502 });
    }
    const payload = await result.json() as { session?: { id?: unknown }; transport?: { type?: unknown; sdp?: unknown } };
    if (typeof payload.session?.id !== 'string' || payload.transport?.type !== 'webrtc' || typeof payload.transport.sdp !== 'string') {
      await Promise.all([store.releaseCallLease(sessionId, leaseId), setup(`call-setup:${leaseId}`, 'error', { error: 'GPT-Live sent an unusable answer' })]);
      return new Response('Invalid voice response', { status: 502 });
    }
    const traced = setup(payload.session.id, 'ok');
    if (!(await store.bindCallLease(sessionId, leaseId, payload.session.id))) { await traced; return new Response('Call lease expired', { status: 409 }); }
    await Promise.all([
      store.appendEvent(sessionId, { id: `call:${payload.session.id}:accepted`, at: new Date().toISOString(), type: 'call', phase: 'accepted', callId: payload.session.id }),
      traced,
    ]);
    return Response.json({ session: { id: payload.session.id }, transport: { type: 'webrtc', sdp: payload.transport.sdp }, greeting, greetingLine, limits, delegation }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  };
}
