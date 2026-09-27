import { describe, expect, it } from 'vitest';
import { projectSession } from '../../lib/domain/project';
import { greetingEvent } from '../../lib/agent/session';
import type { SessionEvent } from '../../lib/domain/events';
import { assistantName, pendingControls, renderCallScreen, renderScreen, settingsLine } from '../../evals/sim/screen';

const at = '2026-09-27T12:00:00.000Z';
/** A change as the customize tool saves it in turn `turn`. */
const customized = (key: string, value: string, turn = 'm1', provenance: 'user_said' | 'assistant_inferred' = 'user_said'): SessionEvent =>
  ({ id: `customize:${key}:${turn}`, at, type: 'fact', key, value, evidence: 'confirmed', provenance, sourceEventId: `customize:${turn}` });
const named: SessionEvent[] = [
  greetingEvent(new Date(at)),
  { id: 'm1', at, type: 'message', speaker: 'user', channel: 'text', text: 'Call yourself Max. My inbox is a mess.' },
  // The name they gave, and a default look the assistant picked to go with it.
  customized('assistant_name', 'Max'),
  customized('avatar', 'sunny', 'm1', 'assistant_inferred'),
  { id: 'call-offer:m1', at, type: 'call', phase: 'offered' },
  { id: 'connection-offer:gmail:m1', at, type: 'connection', toolkit: 'gmail', phase: 'offered', reason: 'See who is waiting on a reply.' },
  { id: 'answer:m1', at, type: 'message', speaker: 'assistant', channel: 'text', text: 'Max it is.\n\nWant a quick call? Or connect Gmail below.' },
];

describe('simulated screen', () => {
  it('shows messages and pending cards with their controls, and nothing from inside the app', () => {
    const state = projectSession(named);
    const screen = renderScreen(state);
    expect(assistantName(state)).toBe('Max');
    expect(screen).toBe([
      'Persona app. Chat with Max, your Persona assistant.',
      '',
      "Max: Hi! I'm your new Persona assistant 👋 I'm here to take stuff off your plate: email, calendar, even phone calls.",
      '',
      "  First up: what should I go by? Or skip that and tell me what's on your mind.",
      'You: Call yourself Max. My inbox is a mess.',
      '(Renamed to Max)',
      '(New look: Sunny)',
      'Max: Max it is.',
      '',
      '  Want a quick call? Or connect Gmail below.',
      '[Card] Max is ready to call — A short call in your browser. Answering asks for your microphone. — buttons: Answer (answer_call) / Not now (not_now_call)',
      '[Card] Connect Gmail — See who is waiting on a reply. Read-only. Start over disconnects it. — buttons: Connect Gmail (connect_gmail) / Not now (not_now_gmail)',
      '',
      'Buttons you can tap: answer_call, not_now_call, connect_gmail, not_now_gmail',
    ].join('\n'));
    expect(screen).not.toMatch(/remember|customize|offer_call|show_connection|fact|decision|provenance|sunny/);
  });

  it('turns resolved cards into short status lines and lists no buttons', () => {
    const state = projectSession([
      ...named,
      { id: 'call-offer:m1:declined', at, type: 'call', phase: 'declined' },
      { id: 'connection:gmail:a1:connected', at, type: 'connection', toolkit: 'gmail', phase: 'connected' },
      { id: 'm2', at, type: 'message', speaker: 'user', channel: 'text', text: 'every weekday at 8 please' },
      { id: 'automation-proposal:m2', at, type: 'automation', automationId: 'a-1', phase: 'proposed', title: 'Morning inbox rundown', schedule: 'every weekday at 8:00 AM', instruction: 'List the emails waiting on my reply.' },
      { id: 'answer:m2', at, type: 'message', speaker: 'assistant', channel: 'text', text: 'Here is a preview.' },
    ]);
    const screen = renderScreen(state);
    expect(screen).toContain('(Call declined)');
    expect(screen).toContain('(Gmail connected)');
    expect(screen).not.toContain('[Card] Connect Gmail');
    expect(screen).toContain('Max: Here is a preview.\n[Card] Recurring task preview: "Morning inbox rundown", Every weekday at 8:00 AM in your time zone — List the emails waiting on my reply. — buttons: Approve (approve_task) / Not now (not_now_task)');
    expect(pendingControls(state)).toEqual(['approve_task', 'not_now_task']);

    const approved = renderScreen(projectSession([
      ...named,
      { id: 'automation-proposal:m1', at, type: 'automation', automationId: 'a-1', phase: 'proposed', title: 'Morning inbox rundown', schedule: 'every weekday at 8:00 AM' },
      { id: 'automation:a-1:approved', at, type: 'automation', automationId: 'a-1', phase: 'approved', title: 'Morning inbox rundown', schedule: 'every weekday at 8:00 AM', nextRunAt: at },
      { id: 'connection:gmail:x:declined', at, type: 'connection', toolkit: 'gmail', phase: 'declined' },
    ]));
    expect(approved).toContain('(Recurring task on: "Morning inbox rundown", every weekday at 8:00 AM)');
    expect(approved).toContain('(Skipped Gmail for now)');
  });

  it('shows a finished call with its ending and transcript, and a live call as a call screen', () => {
    const events: SessionEvent[] = [
      ...named,
      { id: 'call:live_1:accepted', at, type: 'call', phase: 'accepted', callId: 'live_1' },
      { id: 'call:live_1:started', at: '2026-09-27T12:01:00.000Z', type: 'call', phase: 'started', callId: 'live_1' },
      { id: 'voice:live_1:1', at, type: 'voice_fragment', callId: 'live_1', speaker: 'assistant', text: ' Hey, what should I call you?', startMs: 0, endMs: 900, final: false },
      { id: 'voice:live_1:2', at, type: 'voice_fragment', callId: 'live_1', speaker: 'user', text: " I'm Dana and the thing is", startMs: 1_500, endMs: 2_000, final: false },
      { id: 'call:live_1:ended', at: '2026-09-27T12:01:42.000Z', type: 'call', phase: 'ended', callId: 'live_1', reason: 'user_hangup' },
      { id: 'call:live_2:accepted', at, type: 'call', phase: 'accepted', callId: 'live_2' },
      { id: 'call:live_2:started', at, type: 'call', phase: 'started', callId: 'live_2' },
      { id: 'voice:live_2:1', at, type: 'voice_fragment', callId: 'live_2', speaker: 'assistant', text: ' Hi again, Dana.', startMs: 0, endMs: 900, final: false },
    ];
    const state = projectSession(events);
    const chat = renderScreen(state);
    expect(chat).toContain("[Call with Max · 0:42 · You hung up]\n  Max: Hey, what should I call you?\n  You: I'm Dana and the thing is");

    const call = renderCallScreen(state, 'live_2');
    expect(call).toContain("[Call with Max · 0:42 · You hung up]");
    expect(call).not.toContain('[Call with Max · Call]');
    expect(call.endsWith([
      '--- Live call with Max ---',
      'Max: Hi again, Dana.',
      '',
      'Buttons you can still tap on screen: connect_gmail, not_now_gmail',
      '',
      '(You are on a call. Speak, or hang up.)',
    ].join('\n'))).toBe(true);
    // The call offer's buttons are disabled during a call, as in the app.
    expect(pendingControls(state, { onCall: true })).toEqual(['connect_gmail', 'not_now_gmail']);
    expect(call).not.toContain('Buttons you can tap:');
  });

  it('shows the thread\'s lines for what customize changed and for the end of setup', () => {
    const changed = renderScreen(projectSession([
      ...named,
      { id: 'm2', at, type: 'message', speaker: 'user', channel: 'text', text: 'paint yourself as a fox in a hoodie, be more direct, and use the calm voice. then just let me in' },
      customized('avatar', 'img:0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b', 'm2'),
      customized('personality', 'direct', 'm2'),
      customized('voice', 'willow', 'm2'),
      { id: 'onboarding:graduated', at, type: 'onboarding', phase: 'graduated', reason: 'just let me in' },
      { id: 'answer:m2', at, type: 'message', speaker: 'assistant', channel: 'text', text: 'Done. What first?' },
    ]));
    expect(changed).toContain([
      'You: paint yourself as a fox in a hoodie, be more direct, and use the calm voice. then just let me in',
      '(New look: Custom portrait)',
      '(Personality: Direct)',
      '(Call voice: Calm)',
      '(Skipped the rest of setup)',
      'Max: Done. What first?',
    ].join('\n'));
    expect(changed).not.toContain("You're all set up");

    // The four things known: the thread says so once, right after the last one.
    const complete = renderScreen(projectSession([
      ...named,
      { id: 'fact:preferred_name:m2', at, type: 'fact', key: 'preferred_name', value: 'Dana', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm2' },
      { id: 'fact:current_need:m2', at, type: 'fact', key: 'current_need', value: 'inbox triage', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm2' },
      { id: 'connection:gmail:x:declined', at, type: 'connection', toolkit: 'gmail', phase: 'declined' },
    ]));
    expect(complete).toContain("(Skipped Gmail for now)\n(You're all set up)\n\nButtons you can tap: answer_call, not_now_call");
    expect(settingsLine('avatar', 'https://example.test/me.png')).toBe('New photo');
    expect(settingsLine('personality', 'like a friend, less formal')).toBe('Personality: your own description');
  });

  it('names the assistant Persona until the user picks a name', () => {
    const state = projectSession([greetingEvent(new Date(at))]);
    expect(renderScreen(state)).toMatch(/^Persona app\. Chat with Persona, your new assistant\.\n\nPersona: Hi! I'm your new Persona assistant/);
    expect(renderScreen(state)).toMatch(/No buttons to tap right now\.$/);
    expect(renderCallScreen(projectSession([
      greetingEvent(new Date(at)),
      { id: 'call:live_1:accepted', at, type: 'call', phase: 'accepted', callId: 'live_1' },
    ]), 'live_1')).toContain('--- Live call with Persona ---\n(Nobody has said anything yet.)');
  });
});
