import type { SessionEvent, Toolkit } from '../domain/events';
import { projectSession } from '../domain/project';
import { signedInSession, type LoginStore } from '../auth/login';
import { withinIpLimit, type IpQuotaStore } from './client-key';
import { capToolResult, runVoiceTool, toolContext, VOICE_TOOL_NAMES } from '../agent/tools';
import type { AccountReadClient } from '../agent/tools/accounts';
import { withVoiceToolTrace } from '../observability/voice-tool-trace';
import type { TraceSink } from '../observability/trace';
import type { AutomationStore } from '../domain/automation';

interface Store extends IpQuotaStore, LoginStore {
  hasEvent(id: string, eventId: string): Promise<boolean>;
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  getActiveConnection(id: string, toolkit: Toolkit): Promise<string | undefined>;
  consumeQuota(id: string, scope: 'tool', limit: number, windowSeconds: number): Promise<boolean>;
  appendTrace?: TraceSink['appendTrace'];
  /** A call can put a recurring-task preview card in the chat. */
  proposeAutomation?: AutomationStore['proposeAutomation'];
}

export { VOICE_TOOL_NAMES };

/**
 * Runs a function call that GPT-Live's backend requested, forwarded by the browser. The browser is not
 * trusted: the call must belong to this session, arguments are re-validated, and the same tool modules
 * and gates as text chat decide what happens (lib/agent/tools).
 */
export function createVoiceToolHandler(store: Store, env: Record<string, string | undefined>, composio?: AccountReadClient) {
  return withVoiceToolTrace(store, async (request: Request): Promise<Response> => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Unexpected origin', { status: 403 });
    const sessionId = await signedInSession(store, request);
    if (!sessionId) return new Response('Session required', { status: 401 });
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; } catch { return new Response('Invalid JSON', { status: 400 }); }
    const { callId, callItemId, name } = body ?? {};
    if (typeof callId !== 'string' || !/^live_[\w-]{1,100}$/.test(callId) || typeof callItemId !== 'string' || !/^[\w-]{1,100}$/.test(callItemId) ||
        typeof name !== 'string' || !VOICE_TOOL_NAMES.includes(name) || typeof body.arguments !== 'string' || body.arguments.length > 4_000) {
      return new Response('Invalid tool call', { status: 400 });
    }
    if (!(await store.hasEvent(sessionId, `call:${callId}:accepted`))) return new Response('Call not found', { status: 404 });
    if (!(await store.consumeQuota(sessionId, 'tool', 40, 600)) || !(await withinIpLimit(store, request, 'tool'))) return Response.json({ output: JSON.stringify({ status: 'rate_limited' }) });
    let args: unknown;
    try { args = JSON.parse(body.arguments || '{}'); } catch { return Response.json({ output: JSON.stringify({ status: 'invalid_arguments' }) }); }
    const state = projectSession(await store.readEvents(sessionId));
    const ctx = await toolContext({ store, env, composio }, sessionId, state, { channel: 'voice', turnId: `${callId}:${callItemId}` });
    const { output, ui } = await runVoiceTool(ctx, name, args);
    return Response.json({ output: capToolResult(output), ...(ui ? { ui } : {}) });
  });
}
