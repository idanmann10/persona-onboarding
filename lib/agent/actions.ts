import { z } from 'zod';
import type { SessionEvent, Toolkit } from '../domain/events';
import type { SessionProjection } from '../domain/project';
import type { AutomationStore } from '../domain/automation';
import { describeSchedule, isValidSchedule } from '../domain/schedule';
import { AVATARS, CUSTOM_PERSONALITY_LIMIT, DEFAULT_AVATAR, DEFAULT_PERSONALITY, PERSONALITIES, VOICES, avatarFrom, personalityFrom, type VoiceId } from '../domain/persona';
import type { AvatarResult } from '../avatars/generate';

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
  /** Present when a described look can be painted (an OpenAI key and Postgres). */
  avatars?: {
    generate(input: { name: string; description: string }): Promise<AvatarResult>;
    save(sessionId: string, avatar: { id: string; prompt: string; mime: string; bytes: Uint8Array }): Promise<void>;
  };
  now?: () => Date;
}

export const REMEMBER_KEYS = ['preferred_name', 'current_need'] as const;
export type RememberKey = (typeof REMEMBER_KEYS)[number];

export const rememberInput = z.object({
  key: z.enum(REMEMBER_KEYS).describe("preferred_name: the user's own name, only when they say it is theirs. current_need: the task or problem they want handled, in their words."),
  value: z.string().max(300).optional().describe('The value, as the user said it. Omit when declined is true.'),
  declined: z.boolean().optional().describe('True only when they refuse to share this exact thing. Saying no to a call or an account is note_decline, not this.'),
});
export const customizeInput = z.object({
  name: z.string().max(80).optional().describe('A new name for YOU, as the user gave it (1-40 letters, numbers, spaces, . \' -).'),
  avatar: z.string().max(300).optional().describe(`Your look: a default look (${Object.keys(AVATARS).join(', ')}), or the look they asked for in their words, e.g. "a fox in a denim jacket", which is painted as your portrait in a few seconds.`),
  personality: z.string().max(300).optional().describe(`How to come across: ${Object.keys(PERSONALITIES).join(', ')} when one fits, otherwise their own words (up to ${CUSTOM_PERSONALITY_LIMIT} characters).`),
  voice: z.enum(Object.keys(VOICES) as [VoiceId, ...VoiceId[]]).optional().describe(`Call voice: ${Object.entries(VOICES).map(([id, voice]) => `${id} (${voice.label.toLowerCase()}, ${voice.hint.toLowerCase()})`).join(', ')}.`),
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
  if (input.declined) {
    await ctx.store.appendEvent(ctx.sessionId, { id, at: timestamp(ctx), type: 'fact', key: input.key, value: 'declined', evidence: 'declined', provenance: 'user_said', sourceEventId: ctx.turnId });
    return { status: 'saved' as const, key: input.key, evidence: 'declined' as const };
  }
  const value = input.value?.replace(/\s+/g, ' ').trim() ?? '';
  const limit = input.key === 'current_need' ? 300 : 60;
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

const ASSISTANT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u;
const AVATAR_DESCRIPTION_LIMIT = 200;
const paintedThisTurn = new WeakMap<ActionContext, boolean>();

/** A stable portrait id per session and turn, so a retried turn reuses its painting instead of paying for another. */
async function portraitId(sessionId: string, turnId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`avatar:${sessionId}:${turnId}`)));
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Paint a described look and store it. Never throws: a failure comes back with a reason the model can relay. */
async function paintAvatar(ctx: ActionContext, description: string, newName?: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (!ctx.avatars) return { ok: false, reason: 'Painting a new look is not available here.' };
  if (paintedThisTurn.get(ctx)) return { ok: false, reason: 'One new look per message; ask again for another.' };
  paintedThisTurn.set(ctx, true);
  try {
    const id = await portraitId(ctx.sessionId, ctx.turnId);
    if (ctx.state.facts.avatar?.value === `img:${id}`) return { ok: true, id };
    const saved = ctx.state.onboarding.assistantName;
    const name = newName ?? (saved.status === 'confirmed' || saved.status === 'tentative' ? saved.value : undefined);
    const image = await ctx.avatars.generate({ name: name || 'Persona', description });
    if (!image.ok) {
      console.error('Avatar painting failed', { error: image.error, status: image.status });
      return { ok: false, reason: image.error === 'refused' ? 'The image safety filter refused that look.' : image.error === 'timeout' ? 'Painting took too long.' : 'The painting service had a problem.' };
    }
    await ctx.avatars.save(ctx.sessionId, { id, prompt: image.prompt, mime: image.mime, bytes: image.bytes });
    return { ok: true, id };
  } catch (error) {
    console.error('Avatar painting failed', error);
    return { ok: false, reason: 'The painting service had a problem.' };
  }
}
const UNSAFE = /[\u0000-\u001f\u007f]|https?:\/\/|www\.|\b[\w-]+\.(?:com|net|org|io|ai|co|app|dev|me|ly)\b/i;
type CustomizeKey = 'assistant_name' | 'avatar' | 'personality' | 'voice';
const CUSTOMIZE_FIELDS = { name: 'assistant_name', avatar: 'avatar', personality: 'personality', voice: 'voice' } as const;

/**
 * Change the assistant's own name, look, personality or call voice when the user asks. Every field is
 * checked before anything is saved; each change is a fact the next reply, the next call and the thread use.
 */
export async function customize(ctx: ActionContext, input: z.infer<typeof customizeInput>) {
  const clean = (value?: string) => value?.replace(/\s+/g, ' ').trim();
  const wanted: Partial<Record<CustomizeKey, { value: string; words: string[] }>> = {};
  const name = clean(input.name);
  if (name !== undefined) {
    if (!name || name.length > 40 || !ASSISTANT_NAME.test(name)) return { status: 'rejected' as const, reason: "Use a name of 1 to 40 letters or numbers (spaces, . ' and - are fine)." };
    wanted.assistant_name = { value: name, words: [name] };
  }
  const avatarText = clean(input.avatar);
  let paint: string | undefined;
  if (avatarText !== undefined) {
    const avatar = avatarFrom(avatarText);
    if (avatar) wanted.avatar = { value: avatar, words: avatar.startsWith('#') || avatar === DEFAULT_AVATAR ? [avatar] : [avatar, AVATARS[avatar as keyof typeof AVATARS].label] };
    else if (avatarText.length < 3 || avatarText.length > AVATAR_DESCRIPTION_LIMIT || avatarText.startsWith('#') || /^img:/i.test(avatarText) || UNSAFE.test(avatarText)) {
      return { status: 'rejected' as const, reason: `Describe the look in ${AVATAR_DESCRIPTION_LIMIT} characters or fewer, without links, or pick ${Object.keys(AVATARS).join(', ')}.` };
    } else if (!ctx.avatars) {
      return { status: 'rejected' as const, reason: `A new look can't be painted here. Pick one of ${Object.keys(AVATARS).join(', ')}${ctx.channel === 'voice' ? ', or offer to paint it in the chat after the call' : ''}.` };
    } else paint = avatarText;
  }
  const personalityText = clean(input.personality);
  if (personalityText !== undefined) {
    const preset = personalityFrom(personalityText);
    if (preset.id === 'custom' && (personalityText.length < 3 || personalityText.length > CUSTOM_PERSONALITY_LIMIT || UNSAFE.test(personalityText))) {
      return { status: 'rejected' as const, reason: `Describe the personality in ${CUSTOM_PERSONALITY_LIMIT} characters or fewer, without links, or pick ${Object.keys(PERSONALITIES).join(', ')}.` };
    }
    // A preset is stored by id; anything else is kept in their words and quoted as a style, never as rules.
    wanted.personality = preset.id === 'custom' ? { value: personalityText, words: [personalityText] } : { value: preset.id, words: [preset.id, PERSONALITIES[preset.id].label] };
  }
  if (input.voice !== undefined) wanted.voice = { value: input.voice, words: [input.voice, VOICES[input.voice].label] };
  if (!Object.keys(wanted).length && !paint) return { status: 'rejected' as const, reason: 'Say what to change: name, avatar, personality or voice.' };

  // Everything else checked out; now paint the described look. A failed painting still saves the other changes.
  let paintFailure: string | undefined;
  if (paint) {
    const painted = await paintAvatar(ctx, paint, wanted.assistant_name?.value);
    if (painted.ok) wanted.avatar = { value: `img:${painted.id}`, words: [paint] };
    else paintFailure = painted.reason;
  }

  const sourceEventId = `customize:${ctx.turnId}`;
  const changed: Partial<Record<keyof typeof CUSTOMIZE_FIELDS, string>> = {};
  for (const [field, key] of Object.entries(CUSTOMIZE_FIELDS) as Array<[keyof typeof CUSTOMIZE_FIELDS, CustomizeKey]>) {
    const next = wanted[key];
    if (!next) continue;
    const said = next.words.some((word) => saidByUser(word, ctx.userWords));
    const existing = ctx.state.facts[key];
    const current = existing?.value ?? (key === 'avatar' ? DEFAULT_AVATAR : key === 'personality' ? DEFAULT_PERSONALITY : undefined);
    const same = current === next.value;
    // A name the user said can upgrade the assistant's own tentative pick; otherwise an equal value is no change.
    if (same && !(key === 'assistant_name' && said && existing?.evidence !== 'confirmed')) continue;
    const evidence = said || key !== 'assistant_name' ? 'confirmed' as const : 'tentative' as const;
    const provenance = said ? 'user_said' as const : 'assistant_inferred' as const;
    await ctx.store.appendEvent(ctx.sessionId, { id: `customize:${key}:${ctx.turnId}`, at: timestamp(ctx), type: 'fact', key, value: next.value, evidence, provenance, sourceEventId });
    // A painted look is reported in the words it was painted from; its image id is only for the app.
    changed[field] = key === 'avatar' && paint && next.value.startsWith('img:') ? paint : next.value;
  }
  if (!Object.keys(changed).length) {
    if (paintFailure) return { status: 'failed' as const, reason: paintFailure, note: `Say you couldn't paint that look this time, in a few words. Offer to try again or to pick one of ${Object.keys(AVATARS).join(', ')}.` };
    return { status: 'unchanged' as const, note: 'That is already how it is set.' };
  }
  return {
    status: 'saved' as const, changed, ...(paintFailure ? { failed: { avatar: paintFailure } } : {}),
    note: `The app shows the change in the chat. Switch to it right away.${changed.voice && ctx.channel === 'voice' ? ' The new voice applies from the next call.' : ''}${paintFailure ? " The new look couldn't be painted this time; say so in a few words." : ''}`,
  };
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
    if (ctx.connected[input.what]) return { status: 'already_connected' as const, note: 'It is connected; Start over disconnects it.' };
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
