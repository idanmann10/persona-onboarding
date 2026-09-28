import { z } from 'zod';
import { TOOLKIT_NAMES, TOOLKIT_WORDS, timestamp } from './gates';
import { defineTool } from './types';

/** A Connect button for Gmail or Calendar. Nothing is connected until Google's sign-in finishes in this browser. */
export const showConnection = defineTool({
  name: 'show_connection',
  description: "Put a Connect button for Gmail or Google Calendar on the user's screen when connecting would help with the current need.",
  input: z.object({
    toolkit: z.enum(['gmail', 'calendar']),
    reason: z.string().min(1).max(200).describe('The concrete benefit for the current need, in one line.'),
  }),
  channels: ['text', 'voice'],
  offered: (ctx) => ctx.capabilities.gmail || ctx.capabilities.calendar,
  onCall: (capabilities) => capabilities.gmail || capabilities.calendar,
  async execute(ctx, input) {
    const toolkit = input.toolkit;
    const name = TOOLKIT_NAMES[toolkit];
    if (!ctx.capabilities[toolkit]) return { status: 'unavailable', note: `${name} can't be connected in this preview.` };
    if (ctx.accounts[toolkit]) return { status: 'already_connected' };
    const phase = ctx.state.connections[toolkit];
    if (phase === 'offered') return { status: 'already_shown', note: `The Connect ${name} button is already on screen.` };
    if (phase === 'declined' && !TOOLKIT_WORDS[toolkit].test(ctx.userWords.at(-1) ?? '')) {
      return { status: 'declined_recently', note: `They chose not to connect ${name}. Help without it unless they ask.` };
    }
    await ctx.store.appendEvent(ctx.sessionId, { id: `connection-offer:${toolkit}:${ctx.turnId}`, at: timestamp(ctx), type: 'connection', toolkit, phase: 'offered', reason: input.reason.slice(0, 200) });
    return { status: 'shown', note: `A Connect ${name} button is now on screen, right below your message. Nothing is connected until they finish Google's sign-in.` };
  },
  voiceUi: (result, input) => result.status === 'shown' || result.status === 'already_shown' ? { type: 'connection_offer', toolkit: input.toolkit } : undefined,
});
