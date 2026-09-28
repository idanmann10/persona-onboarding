import { z } from 'zod';
import { timestamp } from './gates';
import { defineTool } from './types';

/** The user said no in their own words ("just text me", "I won't connect my calendar"); it isn't offered again. */
export const noteDecline = defineTool({
  name: 'note_decline',
  description: 'Record that the user said no to a call, to connecting Gmail, or to connecting Google Calendar, so it is not offered again.',
  input: z.object({ what: z.enum(['call', 'gmail', 'calendar']).describe('What the user said no to.') }),
  channels: ['text', 'voice'],
  async execute(ctx, input) {
    if (input.what === 'call') {
      if (ctx.channel === 'voice') return { status: 'already_on_call' };
      if (ctx.state.onboarding.call === 'declined') return { status: 'unchanged' };
      await ctx.store.appendEvent(ctx.sessionId, { id: `call-decline:${ctx.turnId}`, at: timestamp(ctx), type: 'call', phase: 'declined' });
    } else {
      if (ctx.accounts[input.what]) return { status: 'already_connected', note: 'It is connected; Start over disconnects it.' };
      if (ctx.state.connections[input.what] === 'declined') return { status: 'unchanged' };
      await ctx.store.appendEvent(ctx.sessionId, { id: `connection-decline:${input.what}:${ctx.turnId}`, at: timestamp(ctx), type: 'connection', toolkit: input.what, phase: 'declined' });
    }
    return { status: 'saved', note: "Noted. Don't offer it again unless they ask." };
  },
});
