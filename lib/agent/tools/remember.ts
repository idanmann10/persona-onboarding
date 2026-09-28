import { z } from 'zod';
import { isValidTimeZone } from '../../domain/schedule';
import { normalize, saidByUser, timestamp } from './gates';
import { defineTool } from './types';

export const REMEMBER_KEYS = ['preferred_name', 'current_need', 'location', 'timezone'] as const;

/** Profile corrections land on the fact the sign-in wrote, so theirs wins over its guess from then on. */
const FACT_KEY: Record<(typeof REMEMBER_KEYS)[number], string> = { preferred_name: 'preferred_name', current_need: 'current_need', location: 'location_city', timezone: 'timezone' };
const LIMIT: Record<(typeof REMEMBER_KEYS)[number], number> = { preferred_name: 60, current_need: 300, location: 80, timezone: 60 };

/**
 * The structured things about the user: what to call them, what they need, and corrections to their
 * profile (where they are, their time zone), which replace what sign-in guessed. A name is saved only from
 * their own words, or when it is the name their Google account already carries (they confirmed it);
 * anything else is refused. Everything else worth keeping is a memory (save_memory).
 */
export const remember = defineTool({
  name: 'remember',
  description: 'Save something new or changed: what to call the user (preferred_name), what they want help with (current_need), or a correction to their profile: where they are (location) or their time zone (timezone, as an IANA zone like "America/New_York"). Use declined only when they refuse to share that exact thing.',
  input: z.object({
    key: z.enum(REMEMBER_KEYS).describe("preferred_name: the user's own name, only when they say it is theirs or confirm the name you used. current_need: the task or problem they want handled, in their words. location: a city or place they say they are. timezone: the IANA zone for where they say they are."),
    value: z.string().max(300).optional().describe('The value, as the user said it. Omit when declined is true.'),
    declined: z.boolean().optional().describe('True only when they refuse to share this exact thing. Saying no to a call or an account is note_decline, not this.'),
  }),
  channels: ['text', 'voice'],
  async execute(ctx, input) {
    const key = FACT_KEY[input.key];
    const id = `fact:${key}:${ctx.turnId}`;
    if (input.declined) {
      await ctx.store.appendEvent(ctx.sessionId, { id, at: timestamp(ctx), type: 'fact', key, value: 'declined', evidence: 'declined', provenance: 'user_said', sourceEventId: ctx.turnId });
      return { status: 'saved', key: input.key, evidence: 'declined' };
    }
    const value = input.value?.replace(/\s+/g, ' ').trim() ?? '';
    if (!value || value.length > LIMIT[input.key] || /[\u0000-\u001f]|https?:\/\//i.test(value)) {
      return { status: 'rejected', reason: `Provide a short ${input.key === 'current_need' ? 'description' : input.key === 'preferred_name' ? 'name' : 'value'} without links.` };
    }
    if (input.key === 'timezone' && !isValidTimeZone(value)) return { status: 'rejected', reason: 'Use an IANA time zone name, like "Europe/Berlin".' };
    const said = saidByUser(value, ctx.userWords);
    // Their Google name, confirmed in conversation ("yep, Dana's fine"), is theirs even if this message didn't repeat it.
    const google = input.key === 'preferred_name' && [ctx.state.facts.user_given_name?.value, ctx.state.facts.user_full_name?.value].some((name) => name && normalize(name) === normalize(value));
    if (!said && !google && input.key === 'preferred_name') {
      return { status: 'rejected', reason: 'Only save a name the user actually said. Ask them if you are unsure.' };
    }
    if (!said && input.key === 'location') return { status: 'rejected', reason: 'Only save a place in their own words.' };
    // A profile value is a correction even when it matches sign-in's guess: it makes the guess theirs.
    const profile = input.key === 'location' || input.key === 'timezone';
    const existing = ctx.state.facts[key];
    const theirs = existing?.provenance === 'user_said' || existing?.provenance === 'user_confirmed';
    if (existing && normalize(existing.value) === normalize(value) && (existing.evidence === 'confirmed' || !said) && (!profile || theirs)) {
      return { status: 'unchanged', key: input.key, value: existing.value };
    }
    // A time zone is never in their words verbatim ("I'm in Berlin" is Europe/Berlin), but it is their correction.
    const evidence = said || google || profile ? 'confirmed' as const : 'tentative' as const;
    const provenance = said ? 'user_said' as const : google || profile ? 'user_confirmed' as const : 'assistant_inferred' as const;
    await ctx.store.appendEvent(ctx.sessionId, { id, at: timestamp(ctx), type: 'fact', key, value, evidence, provenance, sourceEventId: ctx.turnId });
    return { status: 'saved', key: input.key, value, evidence, provenance };
  },
});
