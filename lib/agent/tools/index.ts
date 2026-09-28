import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { SessionEvent, Toolkit } from '../../domain/events';
import { projectSession, type SessionProjection } from '../../domain/project';
import { buildUserState } from '../../domain/user-state';
import { onboardingGoals } from '../goals';
import type { AutomationStore } from '../../domain/automation';
import { availableCapabilities } from '../../domain/capabilities';
import { generateAvatar } from '../../avatars/generate';
import { answeredQuestion, userWords } from '../conversation';
import { relevantToolkits, type AccountReadClient } from './accounts';
import type { AgentTool, ToolContext, ToolResult, ToolStore, ToolUi } from './types';
import { remember } from './remember';
import { customize } from './customize';
import { noteDecline } from './note-decline';
import { graduate } from './graduate';
import { offerCall } from './offer-call';
import { approveAutomation, proposeAutomation } from './propose-automation';
import { showConnection } from './show-connection';
import { readCalendarWindow, searchGmail } from './read-account';
import { resolveIdentity } from './resolve-identity';
import { soulNote } from './soul-note';
import { endCall, scheduleCheckIn, stayQuiet } from './follow-up-tools';
import { forgetMemory, recallMemory, saveMemory } from './memory';
import { BUDGET, clipToTokens, estimateTokens } from '../budget';

export type { ToolContext, ToolStore } from './types';

/** Every tool the assistant has, text and call alike. Order is the order models see them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AGENT_TOOLS: ReadonlyArray<AgentTool<any>> = [
  remember, saveMemory, recallMemory, forgetMemory, customize, noteDecline, graduate, offerCall, proposeAutomation, approveAutomation, showConnection, searchGmail, readCalendarWindow, resolveIdentity, soulNote,
  stayQuiet, scheduleCheckIn, endCall,
];

/** A tool result as the model sees it: past its budget it's cut, with a note saying so (the trace keeps all of it). */
export function capToolResult(output: unknown): string {
  const text = JSON.stringify(output ?? null);
  if (estimateTokens(text) <= BUDGET.toolResult) return text;
  return `${clipToTokens(text, BUDGET.toolResult)} [result cut to fit; ask for less, e.g. a narrower search]`;
}

export const VOICE_TOOL_NAMES = AGENT_TOOLS.filter((item) => item.channels.includes('voice')).map((item) => item.name);

export interface ToolDeps {
  store: ToolStore & { getActiveConnection(sessionId: string, toolkit: Toolkit): Promise<string | undefined> } & Partial<Pick<AutomationStore, 'proposeAutomation' | 'approveAutomation' | 'getAutomation'>> & { saveAvatar?: NonNullable<ToolContext['avatars']>['save'] };
  env: Record<string, string | undefined>;
  composio?: AccountReadClient;
  /** The identity check for a stated name and company, bound per turn to the user's message that stated it. */
  resolveIdentity?: (sessionId: string, userEvent: Extract<SessionEvent, { type: 'message' }>, clue: { first: string; last: string; company: string }) => Promise<unknown>;
  now?: () => Date;
}

/** The context every tool call runs in, from durable state. The text turn and the call's tool endpoint both build it here. */
export async function toolContext(deps: ToolDeps, sessionId: string, state: SessionProjection, options: { channel: 'text' | 'voice'; turnId: string; trigger?: string; include?: Toolkit[] }): Promise<ToolContext> {
  const capabilities = availableCapabilities(deps.env);
  const accounts: Partial<Record<Toolkit, string>> = deps.composio ? {
    gmail: await deps.store.getActiveConnection(sessionId, 'gmail'),
    calendar: await deps.store.getActiveConnection(sessionId, 'calendar'),
  } : {};
  const words = userWords(state);
  const latestUser = state.messages.filter((message) => message.speaker === 'user').at(-1);
  const resolve = deps.resolveIdentity;
  return {
    store: deps.store, sessionId, channel: options.channel, turnId: options.turnId, ...(options.trigger ? { trigger: options.trigger } : {}), state, userWords: words,
    capabilities: { voice: capabilities.voice, gmail: capabilities.gmail, calendar: capabilities.calendar },
    accounts, relevant: relevantToolkits({ userTexts: words, lastAssistant: answeredQuestion(state), include: options.include }),
    ...(deps.composio ? { composio: deps.composio } : {}),
    ...(deps.store.proposeAutomation ? { automations: { proposeAutomation: deps.store.proposeAutomation, ...(deps.store.approveAutomation ? { approveAutomation: deps.store.approveAutomation } : {}), ...(deps.store.getAutomation ? { getAutomation: deps.store.getAutomation } : {}) } } : {}),
    // Painting a new look was cut from calls: it takes a few seconds and the look shows in the chat.
    ...(options.channel === 'text' && deps.store.saveAvatar && deps.env.OPENAI_API_KEY ? { avatars: { generate: (input) => generateAvatar(input, { env: deps.env }), save: deps.store.saveAvatar } } : {}),
    ...(resolve && latestUser ? { resolveIdentity: (clue) => resolve(sessionId, latestUser, clue) } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
}

/** Tools that can move onboarding along: their result carries the next goal, from the state they just changed. */
const MOVES_SETUP = new Set(['remember', 'customize', 'note_decline', 'graduate', 'show_connection', 'offer_call', 'propose_automation', 'approve_automation']);

/**
 * The goal line in the prompt is read once, at the start of a turn (or a call). When a tool changes where
 * things stand (they skipped Gmail, named you, approved a card), the result says what to aim at now, so the
 * reply keeps going from the new state instead of the old one.
 */
async function withAim(ctx: ToolContext, name: string, output: ToolResult): Promise<ToolResult> {
  if (!MOVES_SETUP.has(name) || !ctx.store.readEvents) return output;
  try {
    const user = buildUserState(projectSession(await ctx.store.readEvents(ctx.sessionId)), ctx.now?.() ?? new Date());
    const goals = onboardingGoals(user, { channel: ctx.channel, voice: ctx.capabilities.voice });
    return goals.target ? { ...output, aim_now: goals.target } : output;
  } catch { return output; }
}

/** The tools a text turn offers now, as AI SDK tools. */
export function textToolSet(ctx: ToolContext): ToolSet {
  const set: ToolSet = {};
  for (const item of AGENT_TOOLS) {
    if (!item.channels.includes('text') || (item.offered && !item.offered(ctx))) continue;
    set[item.name] = tool({
      description: item.description, inputSchema: item.input, execute: async (input: unknown) => withAim(ctx, item.name, await item.execute(ctx, input)),
      // Most results are a status line; a read can be bulky, and a bulky result would ride along every later step.
      toModelOutput: ({ output }) => {
        const text = capToolResult(output);
        return text.length === JSON.stringify(output ?? null).length ? { type: 'json', value: (output ?? null) as never } : { type: 'text', value: text };
      },
    });
  }
  return set;
}

/** The same tools as GPT-Live delegation function schemas, fixed when a call starts. */
export function voiceToolSchemas(capabilities: ToolContext['capabilities']) {
  return AGENT_TOOLS.filter((item) => item.channels.includes('voice') && (item.onCall?.(capabilities) ?? true)).map((item) => {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(item.input) as Record<string, unknown>;
    return { type: 'function' as const, name: item.name, description: item.description, parameters };
  });
}

/** Run one tool a call's backend asked for: re-validated here, gated by the same `execute` as text. */
export async function runVoiceTool(ctx: ToolContext, name: string, args: unknown): Promise<{ output: ToolResult; ui?: ToolUi }> {
  const item = AGENT_TOOLS.find((candidate) => candidate.name === name && candidate.channels.includes('voice'));
  if (!item) return { output: { status: 'unknown_tool' } };
  if (item.offered && !item.offered(ctx)) return { output: { status: 'not_available', note: 'That tool is not available right now.' } };
  const parsed = item.input.safeParse(args);
  if (!parsed.success) return { output: { status: 'invalid_arguments' } };
  const output = await withAim(ctx, item.name, await item.execute(ctx, parsed.data));
  const ui = item.voiceUi?.(output, parsed.data);
  return { output, ...(ui ? { ui } : {}) };
}
