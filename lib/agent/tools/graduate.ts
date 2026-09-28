import { z } from 'zod';
import { timestamp } from './gates';
import { defineTool } from './types';

/**
 * The user chose to skip the rest of setup and get started. From here nothing steers them back to setup
 * questions; the thread shows one line so the choice is visible.
 */
export const graduate = defineTool({
  name: 'graduate',
  description: 'The user wants to skip the rest of setup and just get started ("skip", "just let me in", "enough questions"). After this, no more setup questions.',
  input: z.object({
    reason: z.string().max(160).optional().describe('Briefly, in their words, why they want to skip ahead (e.g. "just let me in").'),
  }),
  channels: ['text', 'voice'],
  offered: (ctx) => ctx.state.setup.stage === 'active',
  async execute(ctx, input) {
    if (ctx.state.setup.stage === 'graduated') return { status: 'unchanged', note: 'Setup is already skipped. Just help.' };
    await ctx.store.appendEvent(ctx.sessionId, {
      id: 'onboarding:graduated', at: timestamp(ctx), type: 'onboarding', phase: 'graduated',
      ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 160) } : {}),
    });
    return { status: 'saved', note: 'Setup skipped. No more setup questions; help with whatever they want now.' };
  },
});
