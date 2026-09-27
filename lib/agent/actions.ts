import { z } from 'zod';
import type { SessionEvent, Toolkit } from '../domain/events';
import type { SessionProjection } from '../domain/project';
import type { AutomationStore } from '../domain/automation';
import { describeSchedule, isValidSchedule } from '../domain/schedule';
import { CUSTOM_PERSONALITY_LIMIT, personalityFrom } from '../domain/persona';

export interface ActionStore {
  appendEvent(id: string, event: SessionEvent): Promise<void>;
}

/**
 * Everything an action needs to decide whether it may run. The model chooses to call an action; this
 * context, built by server code from durable state, decides whether the action is allowed.
 */
export interface ActionContext {
  store: ActionStore;
  sessionId: string;
  channel: 'text' | 'voice';
  /** Stable ID of the turn or function call that asked for the action; makes the action idempotent. */
  turnId: string;
  state: SessionProjection;
  /** The user's own recent words (typed or spoken), newest last. The only evidence for `user_said`. */
  userWords: string[];
  capabilities: { voice: boolean; gmail: boolean; calendar: boolean };
  connected: Partial<Record<Toolkit, boolean>>;
  /** Present when recurring tasks are available (Postgres-backed). */
  automations?: Pick<AutomationStore, 'proposeAutomation'>;
  now?: () => Date;
}

export const REMEMBER_KEYS = ['assistant_name', 'preferred_name', 'current_need', 'personality'] as const;
export type RememberKey = (typeof REMEMBER_KEYS)[number];

export const rememberInput = z.object({
  key: z.enum(REMEMBER_KEYS).describe("assistant_name: the name the user gives YOU. preferred_name: the user's own name, only when they say it is theirs. current_need: the task or problem they want handled, in their words. personality: how they want you to come across; use warm, direct, playful or polished when one fits, otherwise their words."),
  value: z.string().max(300).optional().describe('The value, as the user said it. Omit when declined is true.'),
  declined: z.boolean().optional().describe('True only when they refuse to share this exact thing. Saying no to a call or an account is note_decline, not this.'),
});
export const offerCallInput = z.object({ reason: z.string().max(200).optional().describe('One line on why a call helps now.') });
export const noteDeclineInput = z.object({ what: z.enum(['call', 'gmail', 'calendar']).describe('What the user said no to.') });
export const proposeAutomationInput = z.object({
  title: z.string().min(3).max(80).describe('A short name, e.g. "Morning inbox rundown".'),
  instruction: z.string().min(10).max(500).describe('Exactly what to do each time, in plain words, e.g. "List the emails waiting on my reply, newest first."'),
  cadence: z.enum(['daily', 'weekdays', 'weekly']),
  weekday: z.number().int().min(0).max(6).optional().describe('Weekly only: 0 = Sunday ... 6 = Saturday.'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe('24-hour local time in the user\'s time zone, e.g. "08:00".'),
  toolkits: z.array(z.enum(['gmail', 'calendar'])).max(2).optional().describe('Accounts it reads, if any.'),
});
export const showConnectionInput = z.object({
  toolkit: z.enum(['gmail', 'calendar']),
  reason: z.string().min(1).max(200).describe('The concrete benefit for the current need, in one line.'),
});

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();

/** True when the value appears in the user's own words as a whole-word phrase. */
export function saidByUser(value: string, words: string[]): boolean {
  const needle = normalize(value);
  if (!needle) return false;
  return words.some((text) => ` ${normalize(text)} `.includes(` ${needle} `));
}

const CALL_WORDS = /\b(call|calling|talk|phone|voice|ring|speak)\b/i;
const TOOLKIT_WORDS: Record<Toolkit, RegExp> = {
  gmail: /\b(gmail|e-?mails?|inbox|mail)\b/i,
  calendar: /\b(calendar|schedule|meetings?|agenda)\b/i,
};
const TOOLKIT_NAMES: Record<Toolkit, string> = { gmail: 'Gmail', calendar: 'Google Calendar' };

const timestamp = (ctx: ActionContext) => (ctx.now?.() ?? new Date()).toISOString();

export async function remember(ctx: ActionContext, input: z.infer<typeof rememberInput>) {
  const id = `fact:${input.key}:${ctx.turnId}`;
  if (input.declined && input.key === 'personality') return { status: 'rejected' as const, reason: 'A personality cannot be declined; keep the current one.' };
  if (input.declined) {
    await ctx.store.appendEvent(ctx.sessionId, { id, at: timestamp(ctx), type: 'fact', key: input.key, value: 'declined', evidence: 'declined', provenance: 'user_said', sourceEventId: ctx.turnId });
    return { status: 'saved' as const, key: input.key, evidence: 'declined' as const };
  }
  const raw = input.value?.replace(/\s+/g, ' ').trim() ?? '';
  // A personality that names a preset is stored as the preset; anything else is kept in their words.
  const value = input.key === 'personality' && raw ? (personalityFrom(raw).id === 'custom' ? raw : personalityFrom(raw).id) : raw;
  const limit = input.key === 'current_need' ? 300 : input.key === 'personality' ? CUSTOM_PERSONALITY_LIMIT : 60;
  if (!value || value.length > limit || /[\u0000-\u001f]|https?:\/\//i.test(value)) {
    return { status: 'rejected' as const, reason: `Provide a short ${input.key === 'current_need' ? 'description' : 'name'} without links.` };
  }
  const said = saidByUser(value, ctx.userWords);
  if (!said && input.key === 'preferred_name') {
    return { status: 'rejected' as const, reason: 'Only save a name the user actually said. Ask them if you are unsure.' };
  }
  const existing = ctx.state.facts[input.key];
  if (existing && normalize(existing.value) === normalize(value) && (existing.evidence === 'confirmed' || !said)) {
    return { status: 'unchanged' as const, key: input.key, value: existing.value };
  }
  const evidence = said ? 'confirmed' as const : 'tentative' as const;
  const provenance = said ? 'user_said' as const : 'assistant_inferred' as const;
  await ctx.store.appendEvent(ctx.sessionId, { id, at: timestamp(ctx), type: 'fact', key: input.key, value, evidence, provenance, sourceEventId: ctx.turnId });
  return { status: 'saved' as const, key: input.key, value, evidence, provenance };
}

export async function offerCall(ctx: ActionContext) {
  if (ctx.channel === 'voice') return { status: 'already_on_call' as const };
  if (!ctx.capabilities.voice) return { status: 'unavailable' as const, note: 'Calls are not available here. Continue in text.' };
  const phase = ctx.state.call.phase;
  if (phase === 'accepted' || phase === 'started') return { status: 'already_on_call' as const };
  if (ctx.state.call.offerPending) return { status: 'already_offered' as const, note: 'The Answer button is already in the chat.' };
  if (ctx.state.onboarding.call === 'declined' && !CALL_WORDS.test(ctx.userWords.at(-1) ?? '')) {
    return { status: 'declined_recently' as const, note: 'They said no to a call. Stay in text; offer again only if they ask.' };
  }
  await ctx.store.appendEvent(ctx.sessionId, { id: `call-offer:${ctx.turnId}`, at: timestamp(ctx), type: 'call', phase: 'offered' });
  return { status: 'offered' as const, note: 'An Answer button is now in the chat. The call starts only if they tap it; do not say it has started.' };
}

/** The user said no in their own words ("just text me", "I won't connect my calendar"); don't offer it again. */
export async function noteDecline(ctx: ActionContext, input: z.infer<typeof noteDeclineInput>) {
  if (input.what === 'call') {
    if (ctx.channel === 'voice') return { status: 'already_on_call' as const };
    if (ctx.state.onboarding.call === 'declined') return { status: 'unchanged' as const };
    await ctx.store.appendEvent(ctx.sessionId, { id: `call-decline:${ctx.turnId}`, at: timestamp(ctx), type: 'call', phase: 'declined' });
  } else {
    if (ctx.connected[input.what]) return { status: 'already_connected' as const, note: 'It is connected; they can disconnect it from the menu.' };
    if (ctx.state.connections[input.what] === 'declined') return { status: 'unchanged' as const };
    await ctx.store.appendEvent(ctx.sessionId, { id: `connection-decline:${input.what}:${ctx.turnId}`, at: timestamp(ctx), type: 'connection', toolkit: input.what, phase: 'declined' });
  }
  return { status: 'saved' as const, note: "Noted. Don't offer it again unless they ask." };
}

export async function showConnection(ctx: ActionContext, input: z.infer<typeof showConnectionInput>) {
  const toolkit = input.toolkit;
  const name = TOOLKIT_NAMES[toolkit];
  if (!ctx.capabilities[toolkit]) return { status: 'unavailable' as const, note: `${name} can't be connected in this preview.` };
  if (ctx.connected[toolkit]) return { status: 'already_connected' as const };
  const phase = ctx.state.connections[toolkit];
  if (phase === 'offered') return { status: 'already_shown' as const, note: `The Connect ${name} button is already in the chat.` };
  if (phase === 'declined' && !TOOLKIT_WORDS[toolkit].test(ctx.userWords.at(-1) ?? '')) {
    return { status: 'declined_recently' as const, note: `They chose not to connect ${name}. Help without it unless they ask.` };
  }
  await ctx.store.appendEvent(ctx.sessionId, { id: `connection-offer:${toolkit}:${ctx.turnId}`, at: timestamp(ctx), type: 'connection', toolkit, phase: 'offered', reason: input.reason.slice(0, 200) });
  return { status: 'shown' as const, note: `A Connect ${name} button is now in the chat. Nothing is connected until they finish Google's sign-in.` };
}

const proposedThisTurn = new WeakMap<ActionContext, boolean>();

/**
 * Preview a recurring task. It only creates a proposal card: nothing is scheduled until the user
 * approves it in the UI, which also records their time zone. One active recurring task per session.
 */
export async function proposeAutomation(ctx: ActionContext, input: z.infer<typeof proposeAutomationInput>) {
  if (!ctx.automations) return { status: 'unavailable' as const, note: 'Recurring tasks are not available here.' };
  const schedule = { cadence: input.cadence, weekday: input.cadence === 'weekly' ? input.weekday : undefined, time: input.time };
  if (!isValidSchedule(schedule)) return { status: 'invalid' as const, note: 'A weekly task needs a weekday, and the time must be HH:MM.' };
  if (ctx.state.automations.some((item) => item.status === 'active')) {
    return { status: 'one_active' as const, note: 'They already have an active recurring task. Offer to turn it off first; only one can run.' };
  }
  if (proposedThisTurn.get(ctx) || ctx.state.automations.some((item) => item.status === 'proposed')) {
    return { status: 'already_proposed' as const, note: 'A preview card is already waiting for their approval.' };
  }
  proposedThisTurn.set(ctx, true);
  const id = crypto.randomUUID();
  const toolkits = [...new Set(input.toolkits ?? [])];
  await ctx.automations.proposeAutomation(ctx.sessionId, { id, title: input.title, instruction: input.instruction, toolkits, cadence: schedule.cadence, weekday: schedule.weekday, time: schedule.time });
  await ctx.store.appendEvent(ctx.sessionId, {
    id: `automation-proposal:${ctx.turnId}`, at: timestamp(ctx), type: 'automation', automationId: id, phase: 'proposed',
    title: input.title, schedule: describeSchedule(schedule), instruction: input.instruction,
  });
  return { status: 'proposed' as const, schedule: describeSchedule(schedule), note: 'A preview card with Approve is in the chat. Nothing is scheduled until they approve it; do not say it is set up.' };
}
