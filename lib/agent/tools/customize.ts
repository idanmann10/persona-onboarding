import { z } from 'zod';
import { AVATARS, CUSTOM_PERSONALITY_LIMIT, DEFAULT_AVATAR, DEFAULT_PERSONALITY, PERSONALITIES, VOICES, avatarFrom, personalityFrom, type VoiceId } from '../../domain/persona';
import { UNSAFE, saidByUser, timestamp } from './gates';
import { defineTool, type ToolContext } from './types';

const ASSISTANT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u;
/** Their latest words ask how the assistant comes across ("be more direct", "less chatty", "change your tone"). */
const STYLE_ASK = /\b(personality|tone|style|vibe|sound|come across|attitude|be (more|less)|more (direct|playful|formal|casual|fun|polished|serious|chill|concise)|less (chatty|formal|playful|wordy|serious))\b/i;
const AVATAR_DESCRIPTION_LIMIT = 200;
const paintedThisTurn = new WeakMap<ToolContext, boolean>();

/** A stable portrait id per session and turn, so a retried turn reuses its painting instead of paying for another. */
async function portraitId(sessionId: string, turnId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`avatar:${sessionId}:${turnId}`)));
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Paint a described look and store it. Never throws: a failure comes back with a reason the model can relay. */
async function paintAvatar(ctx: ToolContext, description: string, newName?: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
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

type CustomizeKey = 'assistant_name' | 'avatar' | 'personality' | 'voice';
const CUSTOMIZE_FIELDS = { name: 'assistant_name', avatar: 'avatar', personality: 'personality', voice: 'voice' } as const;

/**
 * Change the assistant's own name, look, personality or call voice when the user asks. Every field is
 * checked before anything is saved; each change is a fact the next reply, the next call and the thread use.
 */
export const customize = defineTool({
  name: 'customize',
  description: 'Change your own name, look (avatar), personality or call voice when the user names you or asks for a change. When you get a name or a new look, also pick the call voice that fits that name and character. Send only what changes.',
  input: z.object({
    name: z.string().max(80).optional().describe('A new name for YOU, as the user gave it (1-40 letters, numbers, spaces, . \' -).'),
    avatar: z.string().max(300).optional().describe(`Your look: a default look (${Object.keys(AVATARS).join(', ')}), or the look they asked for in their words, e.g. "a fox in a denim jacket", which is painted as your portrait in a few seconds.`),
    personality: z.string().max(300).optional().describe(`How to come across: ${Object.keys(PERSONALITIES).join(', ')} when one fits, otherwise their own words (up to ${CUSTOM_PERSONALITY_LIMIT} characters).`),
    voice: z.enum(Object.keys(VOICES) as [VoiceId, ...VoiceId[]]).optional().describe(`Call voice, matched to your name and character: ${Object.entries(VOICES).map(([id, voice]) => `${id} (${voice.hint.toLowerCase()}; ${voice.sounds})`).join(', ')}.`),
  }),
  channels: ['text', 'voice'],
  async execute(ctx, input) {
    const clean = (value?: string) => value?.replace(/\s+/g, ' ').trim();
    const wanted: Partial<Record<CustomizeKey, { value: string; words: string[] }>> = {};
    const name = clean(input.name);
    if (name !== undefined) {
      if (!name || name.length > 40 || !ASSISTANT_NAME.test(name)) return { status: 'rejected', reason: "Use a name of 1 to 40 letters or numbers (spaces, . ' and - are fine)." };
      wanted.assistant_name = { value: name, words: [name] };
    }
    const avatarText = clean(input.avatar);
    let paint: string | undefined;
    if (avatarText !== undefined) {
      const avatar = avatarFrom(avatarText);
      if (avatar) wanted.avatar = { value: avatar, words: avatar.startsWith('#') || avatar === DEFAULT_AVATAR ? [avatar] : [avatar, AVATARS[avatar as keyof typeof AVATARS].label] };
      else if (avatarText.length < 3 || avatarText.length > AVATAR_DESCRIPTION_LIMIT || avatarText.startsWith('#') || /^img:/i.test(avatarText) || UNSAFE.test(avatarText)) {
        return { status: 'rejected', reason: `Describe the look in ${AVATAR_DESCRIPTION_LIMIT} characters or fewer, without links, or pick ${Object.keys(AVATARS).join(', ')}.` };
      } else if (!ctx.avatars) {
        return { status: 'rejected', reason: `A new look can't be painted here. Pick one of ${Object.keys(AVATARS).join(', ')}${ctx.channel === 'voice' ? ', or offer to paint it in the chat after the call' : ''}.` };
      } else paint = avatarText;
    }
    const personalityText = clean(input.personality);
    let skipped: string | undefined;
    if (personalityText !== undefined) {
      const preset = personalityFrom(personalityText);
      if (preset.id === 'custom' && (personalityText.length < 3 || personalityText.length > CUSTOM_PERSONALITY_LIMIT || UNSAFE.test(personalityText))) {
        return { status: 'rejected', reason: `Describe the personality in ${CUSTOM_PERSONALITY_LIMIT} characters or fewer, without links, or pick ${Object.keys(PERSONALITIES).join(', ')}.` };
      }
      // Their style is theirs to set: the model doesn't restyle itself unasked (seen live: it "saved" the default on being named).
      const presetSaid = preset.id !== 'custom' && [preset.id, PERSONALITIES[preset.id].label].some((word) => saidByUser(word, ctx.userWords.slice(-1)));
      if (!presetSaid && !STYLE_ASK.test(ctx.userWords.at(-1) ?? '')) skipped = 'Your personality changes only when they ask for a different style.';
      // A preset is stored by id; anything else is kept in their words and quoted as a style, never as rules.
      else wanted.personality = preset.id === 'custom' ? { value: personalityText, words: [personalityText] } : { value: preset.id, words: [preset.id, PERSONALITIES[preset.id].label] };
    }
    // "Use a calmer voice": a voice picked because they asked for one is theirs, even in the assistant's words.
    const voiceAsked = /\b(voice|sound|accent)\b/i.test(ctx.userWords.at(-1) ?? '');
    if (input.voice !== undefined) {
      // A voice they picked themselves stays until they ask for another; a matched one follows the character.
      const chosen = ctx.state.facts.voice?.provenance;
      if ((chosen === 'user_said' || chosen === 'user_confirmed') && !voiceAsked) skipped ??= 'Your call voice stays the one they chose.';
      else wanted.voice = { value: input.voice, words: [input.voice, VOICES[input.voice].label] };
    }
    if (!Object.keys(wanted).length && !paint) return { status: 'rejected', reason: skipped ?? 'Say what to change: name, avatar, personality or voice.' };

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
      const said = next.words.some((word) => saidByUser(word, ctx.userWords)) || (key === 'voice' && voiceAsked);
      const existing = ctx.state.facts[key];
      const current = existing?.value ?? (key === 'avatar' ? DEFAULT_AVATAR : key === 'personality' ? DEFAULT_PERSONALITY : undefined);
      // A name the user said can upgrade the assistant's own tentative pick; otherwise an equal value is no change.
      if (current === next.value && !(key === 'assistant_name' && said && existing?.evidence !== 'confirmed')) continue;
      const evidence = said || key !== 'assistant_name' ? 'confirmed' as const : 'tentative' as const;
      const provenance = said ? 'user_said' as const : 'assistant_inferred' as const;
      await ctx.store.appendEvent(ctx.sessionId, { id: `customize:${key}:${ctx.turnId}`, at: timestamp(ctx), type: 'fact', key, value: next.value, evidence, provenance, sourceEventId });
      // A painted look is reported in the words it was painted from; its image id is only for the app.
      changed[field] = key === 'avatar' && paint && next.value.startsWith('img:') ? paint : next.value;
    }
    if (!Object.keys(changed).length) {
      if (paintFailure) return { status: 'failed', reason: paintFailure, note: `Say you couldn't paint that look this time, in a few words. Offer to try again or to pick one of ${Object.keys(AVATARS).join(', ')}.` };
      return { status: 'unchanged', note: 'That is already how it is set.' };
    }
    return {
      status: 'saved', changed, ...(paintFailure ? { failed: { avatar: paintFailure } } : {}), ...(skipped ? { not_changed: skipped } : {}),
      note: `The app shows the change in the chat. Switch to it right away.${changed.voice && ctx.channel === 'voice' ? ' The new voice applies from the next call.' : ''}${paintFailure ? " The new look couldn't be painted this time; say so in a few words." : ''}`,
    };
  },
  voiceUi: (result) => result.status === 'saved' ? { type: 'customize' } : undefined,
});
