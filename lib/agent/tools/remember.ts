import { z } from 'zod';
import { acceptNote } from '../../domain/memory';
import { normalize, saidByUser, shortHash, timestamp } from './gates';
import { defineTool } from './types';

export const REMEMBER_KEYS = ['preferred_name', 'current_need', 'note'] as const;

/**
 * What to call the user, what they need, and durable notes (the same memory the background memory keeps,
 * so a call can save what it learns while it's happening). A name is saved only from their own words, or
 * when it is the name their Google account already carries (they confirmed it); anything else is refused.
 */
export const remember = defineTool({
  name: 'remember',
  description: 'Save something new or changed: what to call the user (preferred_name), what they want help with (current_need), or one durable thing they told you about themselves or their work (note). Use declined only when they refuse to share that exact thing.',
  input: z.object({
    key: z.enum(REMEMBER_KEYS).describe("preferred_name: the user's own name, only when they say it is theirs or confirm the name you used. current_need: the task or problem they want handled, in their words. note: a durable fact or preference in one plain line, e.g. \"runs a 12-person design studio\"."),
    value: z.string().max(300).optional().describe('The value, as the user said it. Omit when declined is true.'),
    declined: z.boolean().optional().describe('True only when they refuse to share this exact thing. Saying no to a call or an account is note_decline, not this.'),
  }),
  channels: ['text', 'voice'],
  async execute(ctx, input) {
    if (input.key === 'note') {
      const accepted = acceptNote(ctx.state, input.value ?? '');
      if (!accepted.ok) return { status: accepted.reason === 'duplicate' ? 'unchanged' : 'rejected', reason: 'One plain line, up to 160 characters, no links.' };
      await ctx.store.appendEvent(ctx.sessionId, { id: `note:${ctx.turnId}:${shortHash(accepted.text)}`, at: timestamp(ctx), type: 'note', text: accepted.text, kind: 'fact', source: ctx.channel === 'voice' ? 'call' : 'user', provenance: 'user_said' });
      return { status: 'saved', key: 'note' };
    }
    const id = `fact:${input.key}:${ctx.turnId}`;
    if (input.declined) {
      await ctx.store.appendEvent(ctx.sessionId, { id, at: timestamp(ctx), type: 'fact', key: input.key, value: 'declined', evidence: 'declined', provenance: 'user_said', sourceEventId: ctx.turnId });
      return { status: 'saved', key: input.key, evidence: 'declined' };
    }
    const value = input.value?.replace(/\s+/g, ' ').trim() ?? '';
    const limit = input.key === 'current_need' ? 300 : 60;
    if (!value || value.length > limit || /[\u0000-\u001f]|https?:\/\//i.test(value)) {
      return { status: 'rejected', reason: `Provide a short ${input.key === 'current_need' ? 'description' : 'name'} without links.` };
    }
    const said = saidByUser(value, ctx.userWords);
    // Their Google name, confirmed in conversation ("yep, Dana's fine"), is theirs even if this message didn't repeat it.
    const google = input.key === 'preferred_name' && [ctx.state.facts.user_given_name?.value, ctx.state.facts.user_full_name?.value].some((name) => name && normalize(name) === normalize(value));
    if (!said && !google && input.key === 'preferred_name') {
      return { status: 'rejected', reason: 'Only save a name the user actually said. Ask them if you are unsure.' };
    }
    const existing = ctx.state.facts[input.key];
    if (existing && normalize(existing.value) === normalize(value) && (existing.evidence === 'confirmed' || !said)) {
      return { status: 'unchanged', key: input.key, value: existing.value };
    }
    const evidence = said || google ? 'confirmed' as const : 'tentative' as const;
    const provenance = said ? 'user_said' as const : google ? 'user_confirmed' as const : 'assistant_inferred' as const;
    await ctx.store.appendEvent(ctx.sessionId, { id, at: timestamp(ctx), type: 'fact', key: input.key, value, evidence, provenance, sourceEventId: ctx.turnId });
    return { status: 'saved', key: input.key, value, evidence, provenance };
  },
});
