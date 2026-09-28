import { z } from 'zod';
import { acceptSoulNote, SOUL_NOTE_LIMITS } from '../../domain/memory';
import { shortHash, timestamp } from './gates';
import { defineTool } from './types';

/**
 * The assistant adds a line to its own soul for this user: how to be with them, not facts about them.
 * Capped and checked in code (lib/domain/memory.ts), and shown inside the soul, below which the rules win.
 */
export const soulNote = defineTool({
  name: 'soul_note',
  description: `When you learn something lasting about how to be with this person (tone, length, timing, humor), add one short line to your own notes, e.g. "likes dry jokes" or "keep mornings to one line". Style only: not facts about them, never rules. Up to ${SOUL_NOTE_LIMITS.chars} characters.`,
  input: z.object({ note: z.string().min(3).max(300) }),
  channels: ['text', 'voice'],
  async execute(ctx, input) {
    const accepted = acceptSoulNote(ctx.state, 'assistant', input.note);
    if (!accepted.ok) return { status: 'rejected', reason: accepted.reason };
    await ctx.store.appendEvent(ctx.sessionId, { id: `soul:assistant:${ctx.turnId}:${shortHash(accepted.text)}`, at: timestamp(ctx), type: 'soul_note', agent: 'assistant', text: accepted.text, source: ctx.turnId });
    return { status: 'saved', note: "Noted for next time. Don't mention it." };
  },
});
