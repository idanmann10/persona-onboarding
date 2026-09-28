import type { SessionEvent } from '../lib/domain/events';
import { projectSession } from '../lib/domain/project';
import { buildUserState } from '../lib/domain/user-state';
import { prepareTurn } from '../lib/agent/turn';
import { greetingEvent, greetingText } from '../lib/agent/session';
import { pendingTriggers } from '../lib/agent/follow-ups';
import { coachPrompt } from '../lib/agent/subagents/coach';
import { compactionPrompt, memoryPrompt } from '../lib/agent/subagents/memory';
import { buildLiveSession } from '../lib/voice/session-config';

/**
 * Print exactly what the models are given, built by the app's own code for a few moments in a
 * conversation. No keys or database needed.
 *
 *   bun run prompt:show            every moment
 *   bun run prompt:show text       one of: greeting, text, call, coach, memory, compaction
 */
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 27, 16, 0, seconds)).toISOString();
const store = { appendEvent: async () => undefined, getActiveConnection: async () => undefined };
const env = { OPENAI_API_KEY: 'unused', OPENAI_TEXT_MODEL: 'gpt-6-luna', COMPOSIO_API_KEY: 'unused', COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'ac_gmail', COMPOSIO_CALENDAR_AUTH_CONFIG_ID: 'ac_calendar' };
const now = new Date(at(30));
const deps = { store, env, now: () => now };

// What the Google sign-in records before the greeting (lib/auth/profile.ts).
const signedIn: SessionEvent[] = [
  { id: 's1', at: at(0), type: 'fact', key: 'user_email', value: 'dana@example.com', evidence: 'confirmed', provenance: 'tool_observed', sourceEventId: 'signin:profile' },
  { id: 's2', at: at(0), type: 'fact', key: 'user_full_name', value: 'Dana Levi', evidence: 'tentative', provenance: 'tool_observed', sourceEventId: 'signin:profile' },
  { id: 's3', at: at(0), type: 'fact', key: 'user_given_name', value: 'Dana', evidence: 'tentative', provenance: 'tool_observed', sourceEventId: 'signin:profile' },
  { id: 's4', at: at(0), type: 'fact', key: 'timezone', value: 'Europe/London', evidence: 'tentative', provenance: 'tool_observed', sourceEventId: 'signin:profile' },
];
const greeted = [...signedIn, greetingEvent(projectSession(signedIn), new Date(at(1)))];
const named: SessionEvent[] = [
  ...greeted,
  { id: 'm1', at: at(5), type: 'message', speaker: 'user', channel: 'text', text: 'Call yourself Max' },
  { id: 'f1', at: at(6), type: 'fact', key: 'assistant_name', value: 'Max', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm1' },
  { id: 'answer:m1', at: at(7), type: 'message', speaker: 'assistant', channel: 'text', text: "Max it is.\n\nEasier to talk? Tap Answer and I'll pick up, or just keep typing." },
  { id: 'call-offer:m1', at: at(7), type: 'call', phase: 'offered' },
  { id: 'coach:turn:m1', at: at(8), type: 'coach', trigger: 'turn:m1', reachOut: 'no', why: 'they just named Max; the call card is up', focus: 'call', guidance: 'If they type instead, help first, then check "Dana" is what they like to be called.' },
];
const hungUp: SessionEvent[] = [
  ...named,
  { id: 'call:live_1:accepted', at: at(10), type: 'call', phase: 'accepted', callId: 'live_1' },
  { id: 'call:live_1:started', at: at(11), type: 'call', phase: 'started', callId: 'live_1' },
  { id: 'v1', at: at(12), type: 'voice_fragment', callId: 'live_1', speaker: 'assistant', text: "Hey Dana, it's Max, picking up from the chat. Is Dana what you like to be called?", final: true, startMs: 0, endMs: 2_000 },
  { id: 'v2', at: at(15), type: 'voice_fragment', callId: 'live_1', speaker: 'user', text: 'Yeah Dana is great. Honestly the investor updates, every month I have to', final: true, startMs: 3_000, endMs: 7_000 },
  { id: 'call:live_1:ended', at: at(20), type: 'call', phase: 'ended', callId: 'live_1', reason: 'user_hangup' },
];
// Later: two memories on file, and they correct one of them.
const remembered: SessionEvent[] = [
  ...hungUp,
  { id: 'memory:t1:a', at: at(21), type: 'memory', memoryId: 'm0dana1', text: 'Sends investor updates monthly', kind: 'routine', labels: ['investors', 'writing'], confidence: 'high', source: 'call', provenance: 'user_said', sourceEventId: 'call:live_1', by: 'memory' },
  { id: 'memory:t1:b', at: at(21), type: 'memory', memoryId: 'm0dana2', text: 'Cofounder Sam handles hiring', kind: 'person', labels: ['team', 'hiring'], confidence: 'high', source: 'call', provenance: 'user_said', sourceEventId: 'call:live_1', by: 'memory' },
  { id: 'm2', at: at(25), type: 'message', speaker: 'user', channel: 'text', text: "Actually the investor updates are quarterly now, not monthly. And I'm in Berlin these days." },
];

const moments: Record<string, () => Promise<string>> = {
  greeting: async () => `--- The first message (a template from state, no model call) ---\n${greetingText(projectSession(signedIn), now)}`,
  text: async () => {
    const turn = await prepareTurn(deps, 'demo', remembered, { turnId: 'next' });
    return `${turn.instructions}\n\n[tools offered this turn: ${Object.keys(turn.tools).join(', ')}]`;
  },
  call: async () => {
    const live = buildLiveSession(projectSession(named), env, { gmail: true, calendar: true }, now);
    return [
      '--- GPT-Live session.instructions ---', live.session.instructions,
      '\n--- Greeting instruction (sent after session.started) ---', live.greeting,
      `\n--- Voice: ${live.session.audio.output.voice}; delegation: ${live.delegation ? 'gpt-6-luna with the tools above' : 'off'} ---`,
    ].join('\n');
  },
  coach: async () => {
    const state = projectSession(hungUp);
    const trigger = pendingTriggers(state, now)[0];
    const prompt = coachPrompt(trigger, state, buildUserState(state, now), now);
    return `--- Onboarding coach, after a hang-up (system) ---\n${prompt.system}\n\n--- Input ---\n${JSON.stringify(prompt.input, null, 1)}`;
  },
  memory: async () => {
    const prompt = memoryPrompt(projectSession(remembered), now);
    return prompt ? `--- Memory (system) ---\n${prompt.system}\n\n--- Input ---\n${JSON.stringify(prompt.input, null, 1)}` : '(nothing new for the memory)';
  },
  // With the roll budget lowered so this short conversation already needs folding.
  compaction: async () => {
    const prompt = compactionPrompt(projectSession(remembered), { PERSONA_HISTORY_ROLL_TOKENS: '100' });
    return prompt ? `--- Compaction, folding lines ${prompt.from}-${prompt.to} (system) ---\n${prompt.system}\n\n--- Input ---\n${JSON.stringify(prompt.input, null, 1)}` : '(nothing to compact)';
  },
};

const only = process.argv[2];
if (only && !moments[only]) throw new Error(`Pick one of: ${Object.keys(moments).join(', ')}`);
for (const [name, build] of Object.entries(moments)) {
  if (only && name !== only) continue;
  console.log(`\n===== ${name} =====\n${await build()}`);
}
