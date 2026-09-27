import type { SessionEvent, Toolkit } from '../domain/events';
import { projectSession } from '../domain/project';
import { availableCapabilities } from '../domain/capabilities';
import { readSessionCookie } from './session';
import { remember, rememberInput, showConnection, showConnectionInput, type ActionContext } from '../agent/actions';
import { calendarReadInput, gmailSearchInput, relevantToolkits, runCalendarRead, runGmailSearch, type AccountReadClient } from '../agent/account-tools';
import { userWords } from '../agent/turn';

interface Store {
  sessionExists(id: string): Promise<boolean>;
  hasEvent(id: string, eventId: string): Promise<boolean>;
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  getActiveConnection(id: string, toolkit: Toolkit): Promise<string | undefined>;
  consumeQuota(id: string, scope: 'tool', limit: number, windowSeconds: number): Promise<boolean>;
}

export const VOICE_TOOL_NAMES = ['remember', 'show_connection', 'search_gmail', 'read_calendar_window'] as const;

/**
 * Runs a function call that GPT-Live's backend requested, forwarded by the browser. The browser is not
 * trusted: the call must belong to this session, arguments are re-validated, and the same actions and
 * gates as text chat decide what happens.
 */
export function createVoiceToolHandler(store: Store, env: Record<string, string | undefined>, composio?: AccountReadClient) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Unexpected origin', { status: 403 });
    const sessionId = readSessionCookie(request);
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId) || !(await store.sessionExists(sessionId))) return new Response('Session required', { status: 401 });
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; } catch { return new Response('Invalid JSON', { status: 400 }); }
    const { callId, callItemId, name } = body ?? {};
    if (typeof callId !== 'string' || !/^live_[\w-]{1,100}$/.test(callId) || typeof callItemId !== 'string' || !/^[\w-]{1,100}$/.test(callItemId) ||
        typeof name !== 'string' || !(VOICE_TOOL_NAMES as readonly string[]).includes(name) || typeof body.arguments !== 'string' || body.arguments.length > 4_000) {
      return new Response('Invalid tool call', { status: 400 });
    }
    if (!(await store.hasEvent(sessionId, `call:${callId}:accepted`))) return new Response('Call not found', { status: 404 });
    if (!(await store.consumeQuota(sessionId, 'tool', 40, 600))) return Response.json({ output: JSON.stringify({ status: 'rate_limited' }) });
    let args: unknown;
    try { args = JSON.parse(body.arguments || '{}'); } catch { return Response.json({ output: JSON.stringify({ status: 'invalid_arguments' }) }); }
    const state = projectSession(await store.readEvents(sessionId));
    const capabilities = availableCapabilities(env);
    const accounts: Partial<Record<Toolkit, string>> = composio ? {
      gmail: await store.getActiveConnection(sessionId, 'gmail'),
      calendar: await store.getActiveConnection(sessionId, 'calendar'),
    } : {};
    const words = userWords(state);
    const context: ActionContext = {
      store, sessionId, channel: 'voice', turnId: `${callId}:${callItemId}`, state, userWords: words,
      capabilities: { voice: capabilities.voice, gmail: capabilities.gmail, calendar: capabilities.calendar },
      connected: { gmail: Boolean(accounts.gmail), calendar: Boolean(accounts.calendar) },
    };
    const lastAssistant = [...state.calls].reverse().flatMap((call) => call.utterances).filter((utterance) => utterance.speaker === 'assistant').at(-1)?.text;
    const relevant = relevantToolkits({ userTexts: words, lastAssistant });
    const invalid = () => Response.json({ output: JSON.stringify({ status: 'invalid_arguments' }) });
    if (name === 'remember') {
      const parsed = rememberInput.safeParse(args);
      return parsed.success ? Response.json({ output: JSON.stringify(await remember(context, parsed.data)) }) : invalid();
    }
    if (name === 'show_connection') {
      const parsed = showConnectionInput.safeParse(args);
      if (!parsed.success) return invalid();
      const result = await showConnection(context, parsed.data);
      return Response.json({ output: JSON.stringify(result), ...(result.status === 'shown' || result.status === 'already_shown' ? { ui: { type: 'connection_offer', toolkit: parsed.data.toolkit } } : {}) });
    }
    const toolkit: Toolkit = name === 'search_gmail' ? 'gmail' : 'calendar';
    const accountId = accounts[toolkit];
    if (!composio || !accountId) return Response.json({ output: JSON.stringify({ status: 'not_connected', note: `${toolkit === 'gmail' ? 'Gmail' : 'Google Calendar'} is not connected. Offer to put the Connect button on their screen.` }) });
    if (!relevant.includes(toolkit)) return Response.json({ output: JSON.stringify({ status: 'not_relevant', note: 'Read the account only for a request the user made about it.' }) });
    if (name === 'search_gmail') {
      const parsed = gmailSearchInput.safeParse(args);
      return parsed.success ? Response.json({ output: JSON.stringify(await runGmailSearch(composio, accountId, sessionId, parsed.data)) }) : invalid();
    }
    const parsed = calendarReadInput.safeParse(args);
    return parsed.success ? Response.json({ output: JSON.stringify(await runCalendarRead(composio, accountId, sessionId, parsed.data)) }) : invalid();
  };
}
