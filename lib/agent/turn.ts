import type { ModelMessage, ToolSet } from 'ai';
import type { SessionEvent, Toolkit } from '../domain/events';
import { projectSession, type SessionProjection } from '../domain/project';
import { buildUserState, IDENTITY_KEYS } from '../domain/user-state';
import { soulNotes } from '../domain/memory';
import { buildPrompt } from './prompts';
import { historyWindow, windowMessages } from './conversation';
import { textToolSet, toolContext, type ToolDeps } from './tools';
import { describeTurn, type TraceSink, type TurnTrace } from '../observability/trace';

export interface TurnDependencies extends ToolDeps {
  /** Where the agent log goes; turns are traced only when this is set. */
  trace?: TraceSink;
}

/**
 * Something other than a user message woke the assistant: a follow-up the coach asked for, a recurring
 * task's run, a line the call needs. The note is added after the conversation as an app note.
 */
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

/** Facts the prompt already shows elsewhere (names, persona, the profile), so the "other facts" list stays short. */
const SHOWN_ELSEWHERE = new Set<string>(['identity_lookup_status', 'assistant_name', 'preferred_name', 'current_need', 'personality', 'voice', 'avatar', 'public_identity_candidate', 'public_headline', ...IDENTITY_KEYS]);

/** What the model can use, in words, from what's configured and connected. */
export function capabilityLabels(ctx: { capabilities: { voice: boolean; gmail: boolean; calendar: boolean }; accounts: Partial<Record<Toolkit, string>> }, state: SessionProjection): string[] {
  return [
    'text',
    ...(ctx.capabilities.voice ? ['browser call'] : []),
    ...(ctx.accounts.gmail ? ['connected Gmail (read-only search)'] : ctx.capabilities.gmail ? ['Gmail (not connected; can be connected)'] : []),
    ...(ctx.accounts.calendar ? ['connected Google Calendar (read-only)'] : ctx.capabilities.calendar ? ['Google Calendar (not connected; can be connected)'] : []),
    ...Object.values(state.apps).filter((app) => app.phase === 'connected').map((app) => `${app.name} (connected; you can't act in it yet)`),
  ];
}

export function otherFacts(state: SessionProjection) {
  return Object.entries(state.facts).filter(([key]) => !SHOWN_ELSEWHERE.has(key))
    .map(([key, fact]) => ({ key, value: fact.value, provenance: fact.provenance, evidence: fact.evidence, ...(fact.sourceUrl ? { sourceUrl: fact.sourceUrl } : {}) }));
}

export async function prepareTurn(deps: TurnDependencies, sessionId: string, history: SessionEvent[], options: { turnId: string; trigger?: TurnTrigger; channel?: 'text' | 'voice' }): Promise<PreparedTurn> {
  const state = projectSession(history);
  const channel = options.channel ?? 'text';
  const now = deps.now?.() ?? new Date();
  const ctx = await toolContext(deps, sessionId, state, { channel, turnId: options.turnId, trigger: options.trigger?.id, include: options.trigger?.include });
  const tools = textToolSet(ctx);
  const { instructions, context } = buildPrompt({
    user: buildUserState(state, now, deps.env.OPENAI_VOICE), mode: channel === 'voice' ? 'voice_backend' : 'text',
    capabilities: capabilityLabels(ctx, state), soulNotes: soulNotes(state, 'assistant'), facts: otherFacts(state),
  });
  const window = historyWindow(state);
  const messages = windowMessages(window);
  if (options.trigger) messages.push({ role: 'system', content: options.trigger.instruction });
  const latestUser = state.messages.filter((message) => message.speaker === 'user').at(-1);
  // What each part of the prompt took, and how much of the conversation was replayed, trimmed or summarized.
  const budget = {
    ...context.tokens, history: window.tokens, total: context.tokens.total + window.tokens,
    memories: `${context.memories.shown} of ${context.memories.total}`,
    replayed: `${window.lines.length} lines${window.trimmed ? `, ${window.trimmed} trimmed` : ''}${window.start ? `; ${state.memory.summary?.lines ?? 0} in the summary${window.dropped ? `, ${window.dropped} past the cap` : ''}` : ''}`,
  };
  const trace = deps.trace ? describeTurn(deps.trace, sessionId, { turnId: options.turnId, trigger: options.trigger, channel, model: deps.env.OPENAI_TEXT_MODEL, instructions, messages, tools, userText: latestUser?.text, context: budget }) : undefined;
  return { instructions, messages, tools, state, allowSystemInMessages: Boolean(options.trigger), ...(trace ? { trace } : {}) };
}
