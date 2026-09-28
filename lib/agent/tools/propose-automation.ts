import { z } from 'zod';
import { describeSchedule, isValidSchedule, isValidTimeZone, nextRun, type Schedule } from '../../domain/schedule';
import { defineTool, type ToolContext } from './types';
import { timestamp } from './gates';

const proposedThisTurn = new WeakMap<ToolContext, boolean>();

/** Their own words saying yes, or asking for the task themselves: a spoken or typed approval, as good as the tap. */
const SAID_YES = /\b(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|set (it|that|this) up|sounds good|perfect|please|approve|let'?s do (it|that)|turn it on|start it)\b/i;
const ASKED_FOR_IT = /\b(every|each|daily|weekdays?|weekly|mornings?|remind me|rundown|summary|schedule)\b/i;

/**
 * Turns a proposed task on, the same way the card's Approve does: the first run in their time zone (the
 * one their browser reported), the `approved` event, and one active task per conversation.
 */
async function approve(ctx: ToolContext, automation: { id: string; title: string; schedule: Schedule; toolkits?: Array<'gmail' | 'calendar'> }) {
  if (!ctx.automations?.approveAutomation) return { status: 'unavailable', note: 'Approving here is not available; they can tap Approve on the card.' };
  const zone = ctx.state.facts.timezone?.value;
  const timezone = zone && isValidTimeZone(zone) ? zone : 'UTC';
  const first = nextRun(automation.schedule, timezone, ctx.now?.() ?? new Date());
  const result = await ctx.automations.approveAutomation(ctx.sessionId, automation.id, timezone, first);
  if (result !== 'approved') return { status: result, note: result === 'conflict' ? 'Another recurring task is already active; only one can run.' : 'That task is gone.' };
  const described = describeSchedule(automation.schedule);
  await ctx.store.appendEvent(ctx.sessionId, { id: `automation:${automation.id}:approved`, at: timestamp(ctx), type: 'automation', automationId: automation.id, phase: 'approved', title: automation.title, schedule: described, nextRunAt: first.toISOString() });
  const missing = (automation.toolkits ?? []).filter((toolkit) => !ctx.accounts[toolkit]);
  const connect = missing.length ? ` It reads ${missing.map((toolkit) => (toolkit === 'gmail' ? 'Gmail' : 'Google Calendar')).join(' and ')}, which isn't connected yet: call show_connection now so the Connect button appears, and don't mention a button until it returns shown.` : '';
  return { status: 'approved', schedule: described, first_run: first.toISOString(), timezone, note: `It's on: "${automation.title}", ${described}. The first run is ${first.toISOString()} (${timezone}).${connect}` };
}

/**
 * Preview a recurring task, or, when they already said yes out loud or in the chat (or asked for it
 * themselves), turn it on at once: a clear spoken or typed yes is as good as the Approve tap. One active
 * recurring task per session.
 */
export const proposeAutomation = defineTool({
  name: 'propose_automation',
  description: 'Set up one recurring task (daily, weekdays or weekly at a local time). With approved: true, when they already said yes or asked for it, it starts right away; otherwise a preview card with Approve appears.',
  input: z.object({
    title: z.string().min(3).max(80).describe('A short name, e.g. "Morning inbox rundown".'),
    instruction: z.string().min(10).max(500).describe('Exactly what to do each time, in plain words, e.g. "List the emails waiting on my reply, newest first."'),
    cadence: z.enum(['daily', 'weekdays', 'weekly']),
    weekday: z.number().int().min(0).max(6).optional().describe('Weekly only: 0 = Sunday ... 6 = Saturday.'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe('24-hour local time in the user\'s time zone, e.g. "08:00".'),
    toolkits: z.array(z.enum(['gmail', 'calendar'])).max(2).optional().describe('Accounts it reads, if any.'),
    approved: z.boolean().optional().describe('true when they already clearly said yes to this exact task, out loud or in the chat, or asked for it themselves ("send me a rundown every weekday at 8"): it starts right away, no tap needed.'),
  }),
  channels: ['text', 'voice'],
  // A recurring task's own run never proposes another one.
  offered: (ctx) => Boolean(ctx.automations) && !ctx.trigger?.startsWith('automation:'),
  async execute(ctx, input) {
    if (!ctx.automations) return { status: 'unavailable', note: 'Recurring tasks are not available here.' };
    const schedule = { cadence: input.cadence, weekday: input.cadence === 'weekly' ? input.weekday : undefined, time: input.time };
    if (!isValidSchedule(schedule)) return { status: 'invalid', note: 'A weekly task needs a weekday, and the time must be HH:MM.' };
    if (ctx.state.automations.some((item) => item.status === 'active')) {
      return { status: 'one_active', note: 'They already have an active recurring task. Offer to turn it off first; only one can run.' };
    }
    if (proposedThisTurn.get(ctx) || ctx.state.automations.some((item) => item.status === 'proposed')) {
      return { status: 'already_proposed', note: 'A preview card is already waiting for their approval.' };
    }
    proposedThisTurn.set(ctx, true);
    const said = ctx.userWords.at(-1) ?? '';
    const approvedNow = Boolean(input.approved) && (SAID_YES.test(said) || ASKED_FOR_IT.test(said));
    const id = crypto.randomUUID();
    const toolkits = [...new Set(input.toolkits ?? [])];
    await ctx.automations.proposeAutomation(ctx.sessionId, { id, title: input.title, instruction: input.instruction, toolkits, cadence: schedule.cadence, weekday: schedule.weekday, time: schedule.time });
    await ctx.store.appendEvent(ctx.sessionId, {
      id: `automation-proposal:${ctx.turnId}`, at: timestamp(ctx), type: 'automation', automationId: id, phase: 'proposed',
      title: input.title, schedule: describeSchedule(schedule), instruction: input.instruction,
    });
    if (approvedNow) return approve(ctx, { id, title: input.title, schedule, toolkits });
    return { status: 'proposed', schedule: describeSchedule(schedule), note: `A preview card with Approve is in the chat${ctx.channel === 'voice' ? ', behind the call' : ''}. It's on once they say yes (then call approve_automation) or tap Approve; until then, don't say it is set up.` };
  },
  voiceUi: (result) => result.status === 'proposed' || result.status === 'already_proposed' ? { type: 'automation_proposal' } : undefined,
});

/** Their spoken or typed yes to the task waiting on screen turns it on, the same as tapping Approve. */
export const approveAutomation = defineTool({
  name: 'approve_automation',
  description: 'Turn on the recurring task that is waiting for approval, when they say yes to it out loud or in the chat.',
  input: z.object({}),
  channels: ['text', 'voice'],
  offered: (ctx) => Boolean(ctx.automations?.approveAutomation) && ctx.state.automations.some((item) => item.status === 'proposed'),
  async execute(ctx) {
    const waiting = [...ctx.state.automations].reverse().find((item) => item.status === 'proposed');
    if (!waiting) return { status: 'none_waiting', note: 'No task is waiting for approval.' };
    if (!SAID_YES.test(ctx.userWords.at(-1) ?? '')) return { status: 'no_yes_yet', note: 'Their last words are not a yes to it. Ask, or let them tap Approve.' };
    const automation = await ctx.automations!.getAutomation?.(ctx.sessionId, waiting.automationId);
    const schedule = automation ? { cadence: automation.cadence, weekday: automation.weekday, time: automation.time } : undefined;
    if (!schedule) return { status: 'unavailable', note: 'They can tap Approve on the card.' };
    return approve(ctx, { id: waiting.automationId, title: waiting.title, schedule, toolkits: automation?.toolkits });
  },
});
