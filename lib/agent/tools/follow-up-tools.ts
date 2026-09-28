import { z } from 'zod';
import { lifecycleOf, localClock, userTimeZone } from '../../domain/user-state';
import { nextRun } from '../../domain/schedule';
import { shortHash, timestamp } from './gates';
import { defineTool } from './types';

/** Check-ins and the choice to stay quiet: how the assistant paces itself during onboarding. */

const QUIET_FROM = 22;
const QUIET_TO = 8;

/** Only when the app woke the assistant (a call ended, an account connected...): the choice not to write. */
export const stayQuiet = defineTool({
  name: 'stay_quiet',
  description: "You were woken by an app event, not a message, and a message now wouldn't be worth the interruption. Say why in a few words; nothing is sent.",
  input: z.object({ reason: z.string().min(3).max(160) }),
  channels: ['text'],
  offered: (ctx) => Boolean(ctx.trigger?.startsWith('followup:')),
  async execute() {
    return { status: 'quiet', note: 'Nothing will be sent. Write nothing else.' };
  },
});

/**
 * One gentle nudge for later, during onboarding. The newest replaces any earlier one and anything the user
 * writes cancels it (lib/agent/follow-ups.ts); quiet hours move it to the next morning, their time.
 */
export const scheduleCheckIn = defineTool({
  name: 'schedule_check_in',
  description: 'Set one gentle check-in for later (a few hours, or the next morning their time), only when something concrete is waiting on them and a nudge would genuinely help. A new one replaces the old; anything they write cancels it.',
  input: z.object({
    in_minutes: z.number().int().min(30).max(4_320).describe('How long from now, in minutes.'),
    reason: z.string().min(3).max(160).describe('What the nudge is about, e.g. "the Gmail card is still waiting".'),
  }),
  channels: ['text'],
  offered: (ctx) => lifecycleOf(ctx.state, ctx.now?.() ?? new Date()).stage === 'onboarding' && !ctx.trigger?.startsWith('automation:'),
  async execute(ctx, input) {
    const now = ctx.now?.() ?? new Date();
    const zone = userTimeZone(ctx.state) ?? 'UTC';
    let wake = new Date(now.getTime() + input.in_minutes * 60_000);
    const hour = localClock(wake, zone).hour;
    if (hour >= QUIET_FROM || hour < QUIET_TO) wake = nextRun({ cadence: 'daily', time: '08:30' }, zone, wake);
    const reason = input.reason.replace(/\s+/g, ' ').trim();
    await ctx.store.appendEvent(ctx.sessionId, { id: `check-in:${ctx.turnId}:${shortHash(reason)}`, at: timestamp(ctx), type: 'check_in', wakeAt: wake.toISOString(), reason });
    return { status: 'scheduled', at: wake.toISOString(), note: "Scheduled. Don't mention it." };
  },
});

/**
 * A call's natural end: the assistant hangs up after a goodbye. The browser closes the line once the
 * spoken goodbye has finished (lib/voice/client.ts).
 */
export const endCall = defineTool({
  name: 'end_call',
  description: 'Hang up after a natural goodbye (they said bye, or they want to switch to text and you have wrapped up). Say your goodbye first; the line closes when you finish speaking.',
  input: z.object({ reason: z.string().max(120).optional() }),
  channels: ['voice'],
  async execute(ctx) {
    const live = ctx.state.call.phase === 'accepted' || ctx.state.call.phase === 'started';
    return live ? { status: 'ending', note: 'The line closes once your goodbye finishes. Say nothing more after it.' } : { status: 'not_on_call' };
  },
  voiceUi: (result) => result.status === 'ending' ? { type: 'end_call' } : undefined,
});
