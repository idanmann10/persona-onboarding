import { readSessionCookie } from '../http/session';
import { clip, outputSummary, recordTrace, type TraceSink } from './trace';

/**
 * Wraps the voice tool endpoint so every tool call GPT-Live made during a call lands in the agent log:
 * which tool, its arguments, what came back and how long it took. Requests the handler refused
 * (wrong origin, unknown call) are not tool calls and are not recorded.
 */
export function withVoiceToolTrace(store: Partial<TraceSink>, handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    if (!store.appendTrace) return handler(request);
    const body = await request.clone().json().catch(() => undefined) as Record<string, unknown> | undefined;
    const started = Date.now();
    const response = await handler(request);
    const sessionId = readSessionCookie(request);
    const callId = typeof body?.callId === 'string' ? body.callId : undefined;
    const name = typeof body?.name === 'string' ? body.name : undefined;
    if (!response.ok || !sessionId || !callId || !name) return response;
    const durationMs = Date.now() - started;
    const payload = await response.clone().json().catch(() => undefined) as { output?: unknown; ui?: unknown } | undefined;
    const summary = outputSummary(payload?.output);
    await recordTrace(store, sessionId, {
      turnId: callId, kind: 'voice_tool', name, at: new Date().toISOString(), durationMs,
      status: summary.status === 'unavailable' || summary.status === 'error' ? 'error' : 'ok',
      data: { input: clip(body?.arguments, 400), status: summary.status ?? 'done', preview: summary.preview, callItemId: body?.callItemId, ...(payload?.ui ? { ui: payload.ui } : {}) },
    });
    return response;
  };
}
