import { z } from 'zod';
import { describeSchedule, isValidSchedule } from '../../domain/schedule';
import { defineTool, type ToolContext } from './types';
import { timestamp } from './gates';

const proposedThisTurn = new WeakMap<ToolContext, boolean>();

/**
 * Preview a recurring task. It only creates a proposal card: nothing is scheduled until the user
 * approves it in the UI, which also records their time zone. One active recurring task per session.
 */
export const proposeAutomation = defineTool({
  name: 'propose_automation',
  description: 'Show a preview card for one recurring task (daily, weekdays or weekly at a local time) with an Approve button. Nothing is scheduled until they approve it.',
  input: z.object({
    title: z.string().min(3).max(80).describe('A short name, e.g. "Morning inbox rundown".'),
    instruction: z.string().min(10).max(500).describe('Exactly what to do each time, in plain words, e.g. "List the emails waiting on my reply, newest first."'),
    cadence: z.enum(['daily', 'weekdays', 'weekly']),
    weekday: z.number().int().min(0).max(6).optional().describe('Weekly only: 0 = Sunday ... 6 = Saturday.'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe('24-hour local time in the user\'s time zone, e.g. "08:00".'),
    toolkits: z.array(z.enum(['gmail', 'calendar'])).max(2).optional().describe('Accounts it reads, if any.'),
  }),
  channels: ['text'],
  // A recurring task's own run never proposes another one.
  offered: (ctx) => Boolean(ctx.automations) && !ctx.trigger?.startsWith('automation:'),
  async execute(ctx, input) {
    if (!ctx.automations || ctx.channel === 'voice') return { status: 'unavailable', note: 'Recurring tasks are set up in the chat, not on a call.' };
    const schedule = { cadence: input.cadence, weekday: input.cadence === 'weekly' ? input.weekday : undefined, time: input.time };
    if (!isValidSchedule(schedule)) return { status: 'invalid', note: 'A weekly task needs a weekday, and the time must be HH:MM.' };
    if (ctx.state.automations.some((item) => item.status === 'active')) {
      return { status: 'one_active', note: 'They already have an active recurring task. Offer to turn it off first; only one can run.' };
    }
    if (proposedThisTurn.get(ctx) || ctx.state.automations.some((item) => item.status === 'proposed')) {
      return { status: 'already_proposed', note: 'A preview card is already waiting for their approval.' };
    }
    proposedThisTurn.set(ctx, true);
    const id = crypto.randomUUID();
    const toolkits = [...new Set(input.toolkits ?? [])];
    await ctx.automations.proposeAutomation(ctx.sessionId, { id, title: input.title, instruction: input.instruction, toolkits, cadence: schedule.cadence, weekday: schedule.weekday, time: schedule.time });
    await ctx.store.appendEvent(ctx.sessionId, {
      id: `automation-proposal:${ctx.turnId}`, at: timestamp(ctx), type: 'automation', automationId: id, phase: 'proposed',
      title: input.title, schedule: describeSchedule(schedule), instruction: input.instruction,
    });
    return { status: 'proposed', schedule: describeSchedule(schedule), note: 'A preview card with Approve is in the chat. Nothing is scheduled until they approve it; do not say it is set up.' };
  },
});
