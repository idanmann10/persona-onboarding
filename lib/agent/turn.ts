import { tool, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import type { CallEndReason, SessionEvent, Toolkit } from '../domain/events';
import { projectSession, type SessionProjection } from '../domain/project';
import { availableCapabilities } from '../domain/capabilities';
import { buildSystemPrompt } from './prompts';
import { customize, customizeInput, noteDecline, noteDeclineInput, offerCall, offerCallInput, proposeAutomation, proposeAutomationInput, remember, rememberInput, showConnection, showConnectionInput, type ActionContext, type ActionStore } from './actions';
import type { AutomationStore } from '../domain/automation';
import { createAccountTools, relevantToolkits, type AccountReadClient } from './account-tools';
import { personalityLine, personaSettings } from '../domain/persona';
import { describeTurn, type TraceSink, type TurnTrace } from '../observability/trace';

type MessageEvent = Extract<SessionEvent, { type: 'message' }>;

export interface TurnStore extends ActionStore {
  getActiveConnection(sessionId: string, toolkit: Toolkit): Promise<string | undefined>;
}

export interface TurnDependencies {
  store: TurnStore & Partial<Pick<AutomationStore, 'proposeAutomation'>>;
  env: Record<string, string | undefined>;
  composio?: AccountReadClient;
  resolveIdentity?: (sessionId: string, userEvent: MessageEvent, clue: { first: string; last: string; company: string }) => Promise<unknown>;
  now?: () => Date;
  /** Where the agent log goes; turns are traced only when this is set. */
  trace?: TraceSink;
}

/** An app event that wakes the assistant without a new user message (a call ended, Gmail connected). */
export interface TurnTrigger {
  id: string;
  instruction: string;
  include?: Toolkit[];
}

export interface PreparedTurn {
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSet;
  state: SessionProjection;
  allowSystemInMessages: boolean;
  trace?: TurnTrace;
}

const MESSAGE_LIMIT = 40;
const CHARACTER_LIMIT = 24_000;

/** The conversation as the model sees it: text turns plus call turns marked `(on the call)`, newest kept. */
export function modelMessages(state: SessionProjection): ModelMessage[] {
  const flat: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const item of state.timeline) {
    if (item.kind === 'message' && item.text.trim()) flat.push({ role: item.speaker, content: item.channel === 'voice' ? `(on the call) ${item.text}` : item.text });
    if (item.kind === 'call') for (const utterance of item.call.utterances) flat.push({ role: utterance.speaker, content: `(on the call) ${utterance.text}` });
  }
  const kept: typeof flat = [];
  let characters = 0;
  for (let index = flat.length - 1; index >= 0 && kept.length < MESSAGE_LIMIT; index--) {
    const content = flat[index].content.slice(0, 4_000);
    if (characters + content.length > CHARACTER_LIMIT && kept.length) break;
    characters += content.length;
    kept.unshift({ role: flat[index].role, content });
  }
  return kept;
}

/** Every line of the conversation in order, typed or spoken, without channel markers. */
export function conversationLines(state: SessionProjection): Array<{ speaker: 'user' | 'assistant'; text: string }> {
  const lines: Array<{ speaker: 'user' | 'assistant'; text: string }> = [];
  for (const item of state.timeline) {
    if (item.kind === 'message') lines.push({ speaker: item.speaker, text: item.text });
    if (item.kind === 'call') for (const utterance of item.call.utterances) lines.push({ speaker: utterance.speaker, text: utterance.text });
  }
  return lines;
}

/** The assistant line the user's latest words answer (its question before their "yes"), if any. */
export function answeredQuestion(state: SessionProjection): string | undefined {
  const lines = conversationLines(state);
  const lastUser = lines.map((line) => line.speaker).lastIndexOf('user');
  for (let index = lastUser - 1; index >= 0; index--) if (lines[index].speaker === 'assistant') return lines[index].text;
  return undefined;
}

/** The user's own recent words, typed or spoken, newest last. */
export function userWords(state: SessionProjection, limit = 6): string[] {
  const words: string[] = [];
  for (const item of state.timeline) {
    if (item.kind === 'message' && item.speaker === 'user') words.push(item.text);
    if (item.kind === 'call') for (const utterance of item.call.utterances) if (utterance.speaker === 'user') words.push(utterance.text);
  }
  return words.slice(-limit);
}

export const END_REASONS: Record<CallEndReason, string> = {
  user_hangup: 'the user hung up',
  remote_hangup: 'the call was hung up',
  connection_lost: 'the connection dropped',
  page_closed: 'the user closed or left the page',
  lost: 'the call was lost without a goodbye (the page closed or the network went away)',
  inactive: 'it went quiet, so the call was closed',
  max_duration: 'it reached the time limit',
  expired: 'it reached the session time limit',
  content: 'a safety filter stopped it',
  setup_failed: 'it never connected',
};

export function callDuration(startedAt?: string, endedAt?: string): string | undefined {
  if (!startedAt || !endedAt) return undefined;
  const seconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)} min ${seconds % 60}s`;
}

export function callLines(state: SessionProjection): string[] {
  return state.calls.filter((call) => call.startedAt || call.utterances.length).map((call) => {
    const duration = callDuration(call.startedAt, call.endedAt);
    const ending = call.phase === 'ended' || call.phase === 'dropped' ? `ended: ${END_REASONS[call.reason ?? (call.phase === 'dropped' ? 'connection_lost' : 'remote_hangup')]}` : 'still live';
    return `Call${call.startedAt ? ` at ${call.startedAt.slice(11, 16)} UTC` : ''}${duration ? `, ${duration}` : ''}, ${ending}.`;
  });
}

export async function prepareTurn(deps: TurnDependencies, sessionId: string, history: SessionEvent[], options: { turnId: string; trigger?: TurnTrigger; channel?: 'text' | 'voice' }): Promise<PreparedTurn> {
  const state = projectSession(history);
  const capabilities = availableCapabilities(deps.env);
  const accounts: Partial<Record<Toolkit, string>> = deps.composio ? {
    calendar: await deps.store.getActiveConnection(sessionId, 'calendar'),
    gmail: await deps.store.getActiveConnection(sessionId, 'gmail'),
  } : {};
  const connected = { gmail: Boolean(accounts.gmail), calendar: Boolean(accounts.calendar) };
  const words = userWords(state);
  const channel = options.channel ?? 'text';
  const context: ActionContext = {
    store: deps.store, sessionId, channel, turnId: options.turnId, state, userWords: words,
    capabilities: { voice: capabilities.voice, gmail: capabilities.gmail, calendar: capabilities.calendar }, connected, now: deps.now,
    ...(deps.store.proposeAutomation ? { automations: { proposeAutomation: deps.store.proposeAutomation } } : {}),
  };
  const relevant = relevantToolkits({ userTexts: words, lastAssistant: answeredQuestion(state), include: options.trigger?.include });
  const latestUser = state.messages.filter((message) => message.speaker === 'user').at(-1);
  const tools: ToolSet = {
    remember: tool({
      description: 'Save something new or changed: what to call the user (preferred_name) or what they want help with (current_need). Use declined only when they refuse to share that exact thing.',
      inputSchema: rememberInput,
      execute: (input) => remember(context, input),
    }),
    customize: tool({
      description: 'Change your own name, look (avatar), personality or call voice when the user names you or asks for a change. Send only what changes.',
      inputSchema: customizeInput,
      execute: (input) => customize(context, input),
    }),
    note_decline: tool({
      description: 'Record that the user said no to a call, to connecting Gmail, or to connecting Google Calendar, so it is not offered again.',
      inputSchema: noteDeclineInput,
      execute: (input) => noteDecline(context, input),
    }),
    ...(capabilities.voice && channel === 'text' ? {
      offer_call: tool({
        description: 'Put an Answer button in the chat for a short browser call. The button is the invitation: the call starts only if they tap it.',
        inputSchema: offerCallInput,
        execute: () => offerCall(context),
      }),
    } : {}),
    ...(deps.store.proposeAutomation && channel === 'text' && !options.trigger?.id.startsWith('automation:') ? {
      propose_automation: tool({
        description: 'Show a preview card for one recurring task (daily, weekdays or weekly at a local time) with an Approve button. Nothing is scheduled until they approve it.',
        inputSchema: proposeAutomationInput,
        execute: (input) => proposeAutomation(context, input),
      }),
    } : {}),
    ...(capabilities.gmail || capabilities.calendar ? {
      show_connection: tool({
        description: 'Put a Connect button for Gmail or Google Calendar in the chat when connecting would help with the current need.',
        inputSchema: showConnectionInput,
        execute: (input) => showConnection(context, input),
      }),
    } : {}),
    ...(deps.composio ? createAccountTools(deps.composio, sessionId, relevant, accounts, (toolkit, items) => deps.store.appendEvent(sessionId, {
      id: `read:${options.turnId}:${toolkit}`, at: (deps.now?.() ?? new Date()).toISOString(), type: 'account_read', toolkit, items,
    })) : {}),
    ...(deps.resolveIdentity && latestUser ? {
      resolve_identity: tool({
        description: 'Check a directly stated first-person full name and company against a public Context.dev candidate. The server rejects weak or inferred claims.',
        inputSchema: z.object({ first: z.string().min(1), last: z.string().min(1), company: z.string().min(1) }),
        execute: async (clue) => {
          try { return await deps.resolveIdentity!(sessionId, latestUser, clue); }
          catch (error) { console.error('Identity lookup failed', error); return { status: 'unavailable' }; }
        },
      }),
    } : {}),
  };
  const labels = [
    'text',
    ...(capabilities.voice ? ['browser call'] : []),
    ...(connected.gmail ? ['connected Gmail (read-only search)'] : capabilities.gmail ? ['Gmail (not connected; can be connected)'] : []),
    ...(connected.calendar ? ['connected Google Calendar (read-only)'] : capabilities.calendar ? ['Google Calendar (not connected; can be connected)'] : []),
  ];
  const facts = Object.entries(state.facts).map(([key, fact]) => ({ key, value: fact.value, provenance: fact.provenance, evidence: fact.evidence, sourceUrl: fact.sourceUrl }));
  const instructions = buildSystemPrompt({
    facts, capabilities: labels, onboarding: state.onboarding, calls: callLines(state), personality: personalityLine(personaSettings(state)),
    now: (deps.now?.() ?? new Date()).toISOString(), mode: channel === 'voice' ? 'voice_backend' : 'text',
  });
  const messages = modelMessages(state);
  if (options.trigger) messages.push({ role: 'system', content: options.trigger.instruction });
  const trace = deps.trace ? describeTurn(deps.trace, sessionId, { turnId: options.turnId, trigger: options.trigger, channel, model: deps.env.OPENAI_TEXT_MODEL, instructions, messages, tools, userText: latestUser?.text }) : undefined;
  return { instructions, messages, tools, state, allowSystemInMessages: Boolean(options.trigger), ...(trace ? { trace } : {}) };
}
