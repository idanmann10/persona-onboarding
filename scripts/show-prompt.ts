import type { SessionEvent } from '../lib/domain/events';
import { projectSession } from '../lib/domain/project';
import { prepareTurn } from '../lib/agent/turn';
import { describeTrigger } from '../lib/agent/follow-up';
import { greetingEvent } from '../lib/agent/session';
import { buildLiveSession } from '../lib/voice/session-config';

/**
 * Print exactly what the models are given, built by the app's own code for a few moments in a
 * conversation. No keys or database needed.
 *
 *   bun run prompt:show            every moment
 *   bun run prompt:show text       one of: text, call, hangup, gmail
 */
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 27, 16, 0, seconds)).toISOString();
const store = { appendEvent: async () => undefined, getActiveConnection: async () => undefined };
const env = { OPENAI_API_KEY: 'unused', OPENAI_TEXT_MODEL: 'gpt-6-luna', COMPOSIO_API_KEY: 'unused', COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'ac_gmail', COMPOSIO_CALENDAR_AUTH_CONFIG_ID: 'ac_calendar' };
const deps = { store, env, now: () => new Date(at(30)) };

const named: SessionEvent[] = [
  greetingEvent(new Date(at(0))),
  { id: 'm1', at: at(5), type: 'message', speaker: 'user', channel: 'text', text: 'Call yourself Max' },
  { id: 'f1', at: at(6), type: 'fact', key: 'assistant_name', value: 'Max', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm1' },
  { id: 'answer:m1', at: at(7), type: 'message', speaker: 'assistant', channel: 'text', text: "Max it is. Easier to talk? Tap Answer and I'll pick up, or just keep typing." },
  { id: 'call-offer:m1', at: at(7), type: 'call', phase: 'offered' },
];
const hungUp: SessionEvent[] = [
  ...named,
  { id: 'call:live_1:accepted', at: at(10), type: 'call', phase: 'accepted', callId: 'live_1' },
  { id: 'call:live_1:started', at: at(11), type: 'call', phase: 'started', callId: 'live_1' },
  { id: 'v1', at: at(12), type: 'voice_fragment', callId: 'live_1', speaker: 'assistant', text: "Hey, it's Max, picking up from the chat. What should I call you?", final: true, startMs: 0, endMs: 2_000 },
  { id: 'v2', at: at(15), type: 'voice_fragment', callId: 'live_1', speaker: 'user', text: "I'm Dana. Honestly the investor updates, every month I have to", final: true, startMs: 3_000, endMs: 7_000 },
  { id: 'call:live_1:ended', at: at(20), type: 'call', phase: 'ended', callId: 'live_1', reason: 'user_hangup' },
];
const connected: SessionEvent[] = [
  ...named,
  { id: 'm2', at: at(12), type: 'message', speaker: 'user', channel: 'text', text: "I'm Dana. My inbox is out of control" },
  { id: 'connection:gmail:x:connected', at: at(40), type: 'connection', toolkit: 'gmail', phase: 'connected' },
];

const moments: Record<string, () => Promise<string>> = {
  text: async () => {
    const turn = await prepareTurn(deps, 'demo', named, { turnId: 'next' });
    return `${turn.instructions}\n\n[tools offered this turn: ${Object.keys(turn.tools).join(', ')}]`;
  },
  call: async () => {
    const live = buildLiveSession(projectSession(named), env, { gmail: true, calendar: true });
    return [
      '--- GPT-Live session.instructions ---', live.session.instructions,
      '\n--- Greeting instruction (sent after session.started) ---', live.greeting,
      `\n--- Voice: ${live.session.audio.output.voice}; delegation: ${live.delegation ? 'gpt-6-luna with the tools above' : 'off'} ---`,
    ].join('\n');
  },
  hangup: async () => {
    const trigger = describeTrigger(projectSession(hungUp), { kind: 'call_ended', callId: 'live_1' });
    return `--- Follow-up trigger after a hang-up (added as a system message) ---\n${trigger?.instruction}`;
  },
  gmail: async () => {
    const trigger = describeTrigger(projectSession(connected), { kind: 'connection', toolkit: 'gmail' });
    return `--- Follow-up trigger after Gmail connects ---\n${trigger?.instruction}`;
  },
};

const only = process.argv[2];
if (only && !moments[only]) throw new Error(`Pick one of: ${Object.keys(moments).join(', ')}`);
for (const [name, build] of Object.entries(moments)) {
  if (only && name !== only) continue;
  console.log(`\n===== ${name} =====\n${await build()}`);
}
