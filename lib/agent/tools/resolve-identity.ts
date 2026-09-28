import { z } from 'zod';
import { defineTool } from './types';

/** The public identity check (lib/research): the server verifies their actual words and decides whether a lookup is allowed. */
export const resolveIdentity = defineTool({
  name: 'resolve_identity',
  description: 'Check a directly stated first-person full name and company against a public candidate. The server rejects weak or inferred claims.',
  input: z.object({ first: z.string().min(1), last: z.string().min(1), company: z.string().min(1) }),
  channels: ['text'],
  offered: (ctx) => Boolean(ctx.resolveIdentity),
  async execute(ctx, clue) {
    if (!ctx.resolveIdentity) return { status: 'unavailable' };
    try {
      const result = await ctx.resolveIdentity(clue) as Record<string, unknown> | null;
      return { status: 'checked', ...(result ?? {}) };
    } catch (error) { console.error('Identity lookup failed', error); return { status: 'unavailable' }; }
  },
});
