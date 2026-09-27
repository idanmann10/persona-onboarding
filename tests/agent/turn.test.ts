import { describe, expect, it } from 'vitest';
import { answeredQuestion, callLines, modelMessages, prepareTurn, userWords } from '../../lib/agent/turn';
import { relevantToolkits } from '../../lib/agent/account-tools';
import { projectSession } from '../../lib/domain/project';
import type { SessionEvent } from '../../lib/domain/events';

const history: SessionEvent[] = [
  { id: 'greeting:v1', at: '2026-09-27T12:00:00.000Z', type: 'message', speaker: 'assistant', channel: 'text', text: 'Hi, what should I call you?', origin: 'greeting' },
  { id: 'm1', at: '2026-09-27T12:00:05.000Z', type: 'message', speaker: 'user', channel: 'text', text: 'Call yourself Max' },
  { id: 'call:live_1:accepted', at: '2026-09-27T12:01:00.000Z', type: 'call', phase: 'accepted', callId: 'live_1' },
  { id: 'call:live_1:started', at: '2026-09-27T12:01:01.000Z', type: 'call', phase: 'started', callId: 'live_1' },
  { id: 'voice:live_1:1', at: 'x', type: 'voice_fragment', callId: 'live_1', speaker: 'assistant', text: 'Hey, what should I call you?', startMs: 0, endMs: 900, final: false },
  { id: 'voice:live_1:2', at: 'x', type: 'voice_fragment', callId: 'live_1', speaker: 'user', text: "I'm Dana", startMs: 1_500, endMs: 2_000, final: false },
  { id: 'call:live_1:ended', at: '2026-09-27T12:01:31.000Z', type: 'call', phase: 'ended', callId: 'live_1', reason: 'user_hangup' },
];

describe('turn context', () => {
  it('shows calls to the model as marked turns in order', () => {
    expect(modelMessages(projectSession(history))).toEqual([
      { role: 'assistant', content: 'Hi, what should I call you?' },
      { role: 'user', content: 'Call yourself Max' },
      { role: 'assistant', content: '(on the call) Hey, what should I call you?' },
      { role: 'user', content: "(on the call) I'm Dana" },
    ]);
    expect(userWords(projectSession(history))).toEqual(['Call yourself Max', "I'm Dana"]);
    expect(callLines(projectSession(history))).toEqual(['Call at 12:01 UTC, 30s, ended: the user hung up.']);
  });

  it("finds the assistant question the user's latest words answer, across calls", () => {
    const events: SessionEvent[] = [
      { id: 'call:live_a:started', at: 'x', type: 'call', phase: 'started', callId: 'live_a' },
      { id: 'voice:live_a:1', at: 'x', type: 'voice_fragment', callId: 'live_a', speaker: 'assistant', text: 'Let me look at your inbox.', startMs: 0, endMs: 900, final: false },
      { id: 'call:live_a:dropped', at: 'x', type: 'call', phase: 'dropped', callId: 'live_a', reason: 'connection_lost' },
      { id: 'call:live_b:started', at: 'x', type: 'call', phase: 'started', callId: 'live_b' },
      { id: 'voice:live_b:1', at: 'x', type: 'voice_fragment', callId: 'live_b', speaker: 'assistant', text: 'Want me to check tomorrow on your calendar?', startMs: 0, endMs: 900, final: false },
      { id: 'voice:live_b:2', at: 'x', type: 'voice_fragment', callId: 'live_b', speaker: 'user', text: 'Sure.', startMs: 1_500, endMs: 1_900, final: false },
      { id: 'voice:live_b:3', at: 'x', type: 'voice_fragment', callId: 'live_b', speaker: 'assistant', text: 'One moment.', startMs: 2_200, endMs: 2_600, final: false },
    ];
    const state = projectSession(events);
    expect(answeredQuestion(state)).toBe('Want me to check tomorrow on your calendar?');
    expect(relevantToolkits({ userTexts: userWords(state), lastAssistant: answeredQuestion(state) })).toEqual(['calendar']);
  });

  it('keeps the newest turns within the message budget', () => {
    const long: SessionEvent[] = Array.from({ length: 60 }, (_, index) => ({ id: `m${index}`, at: 'x', type: 'message', speaker: index % 2 ? 'assistant' : 'user', channel: 'text', text: `turn ${index}` }));
    const messages = modelMessages(projectSession(long));
    expect(messages).toHaveLength(40);
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'turn 59' });
  });

  it('opens account reads only for an account request, including a yes to the assistant\'s offer', () => {
    expect(relevantToolkits({ userTexts: ['I feel overwhelmed today'] })).toEqual([]);
    expect(relevantToolkits({ userTexts: ["who's waiting on a reply from me?"] })).toEqual(['gmail']);
    expect(relevantToolkits({ userTexts: ['yes please'], lastAssistant: 'Want me to check your inbox for anything urgent?' })).toEqual(['gmail']);
    expect(relevantToolkits({ userTexts: ['yes please'], lastAssistant: 'Want a short plan for today?' })).toEqual([]);
    expect(relevantToolkits({ userTexts: ['hello'], include: ['calendar'] })).toEqual(['calendar']);
  });

  it('builds tools from configured capabilities and appends an event trigger as a system message', async () => {
    const deps = { store: { appendEvent: async () => undefined, getActiveConnection: async () => undefined }, env: { OPENAI_API_KEY: 'k', OPENAI_TEXT_MODEL: 'gpt-6-luna' } };
    const text = await prepareTurn(deps, 's1', history, { turnId: 'm1' });
    expect(Object.keys(text.tools).sort()).toEqual(['customize', 'note_decline', 'offer_call', 'remember']);
    expect(text.instructions).toContain('understand-user/v4');
    expect(text.instructions).toContain('Call at 12:01 UTC');
    expect(text.allowSystemInMessages).toBe(false);
    const triggered = await prepareTurn(deps, 's1', history, { turnId: 'followup:call:live_1', trigger: { id: 'followup:call:live_1', instruction: 'The call ended.' } });
    expect(triggered.messages.at(-1)).toEqual({ role: 'system', content: 'The call ended.' });
    expect(triggered.allowSystemInMessages).toBe(true);
    const composio = { ...deps, env: { ...deps.env, COMPOSIO_API_KEY: 'c', COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'ac' } };
    expect(Object.keys((await prepareTurn(composio, 's1', history, { turnId: 'm1' })).tools)).toContain('show_connection');
  });
});
