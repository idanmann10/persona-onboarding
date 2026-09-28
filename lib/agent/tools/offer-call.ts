import { z } from 'zod';
import { CALL_WORDS, timestamp } from './gates';
import { defineTool } from './types';

/** An Answer button in the chat. The call starts only if they tap it; a declined call stays declined unless they ask. */
export const offerCall = defineTool({
  name: 'offer_call',
  description: 'Put an Answer button in the chat for a short browser call. The button is the invitation: the call starts only if they tap it.',
  input: z.object({ reason: z.string().max(200).optional().describe('One line on why a call helps now.') }),
  channels: ['text'],
  offered: (ctx) => ctx.capabilities.voice,
  async execute(ctx) {
    if (ctx.channel === 'voice') return { status: 'already_on_call' };
    if (!ctx.capabilities.voice) return { status: 'unavailable', note: 'Calls are not available here. Continue in text.' };
    const phase = ctx.state.call.phase;
    if (phase === 'accepted' || phase === 'started') return { status: 'already_on_call' };
    if (ctx.state.call.offerPending) return { status: 'already_offered', note: 'The Answer button is already in the chat.' };
    // After a call, the progress reads 'happened'; a later "no more calls" is the latest call event.
    if ((ctx.state.onboarding.call === 'declined' || ctx.state.call.phase === 'declined') && !CALL_WORDS.test(ctx.userWords.at(-1) ?? '')) {
      return { status: 'declined_recently', note: 'They said no to a call. Stay in text; offer again only if they ask.' };
    }
    await ctx.store.appendEvent(ctx.sessionId, { id: `call-offer:${ctx.turnId}`, at: timestamp(ctx), type: 'call', phase: 'offered' });
    return { status: 'offered', note: 'An Answer button is now in the chat, right below your message. The call starts only if they tap it; do not say it has started.' };
  },
});
