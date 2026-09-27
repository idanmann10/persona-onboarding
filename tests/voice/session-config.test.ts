import { describe, expect, it } from 'vitest';
import { buildLiveSession, estimateTokens, voiceGreeting, voiceInput, voiceInstructions } from '../../lib/voice/session-config';
import { projectSession } from '../../lib/domain/project';
import type { SessionEvent } from '../../lib/domain/events';

const named: SessionEvent[] = [
  { id: 'f1', at: 'x', type: 'fact', key: 'assistant_name', value: 'Max', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm1' },
  { id: 'f2', at: 'x', type: 'fact', key: 'preferred_name', value: 'Dana', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm2' },
];

describe('GPT-Live session configuration', () => {
  it('estimates tokens conservatively for non-Latin text', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('日本語')).toBe(3);
  });

  it('keeps the documented prompt headings and the chosen names', () => {
    const instructions = voiceInstructions(projectSession(named), { gmail: true, calendar: false });
    expect(instructions).toContain('You are Max');
    expect(instructions).toContain("The user's name is Dana.");
    for (const heading of ['Backchannel policy:', 'Interruption policy:', 'Delegation policy:', 'Backend tools:', 'Delegate to the backend when:', 'Do not delegate to the backend when:']) expect(instructions).toContain(heading);
    expect(instructions).toContain('search_gmail');
    expect(instructions).not.toContain('read_calendar_window');
  });

  it('mentions a dropped line only when the last call dropped', () => {
    const call = (id: string, reason: string): SessionEvent[] => [
      { id: `call:${id}:started`, at: 'x', type: 'call', phase: 'started', callId: id },
      { id: `call:${id}:end`, at: 'x', type: 'call', phase: reason === 'connection_lost' ? 'dropped' : 'ended', callId: id, reason: reason as 'connection_lost' },
    ];
    expect(voiceGreeting(projectSession(call('live_1', 'connection_lost')))).toMatch(/line dropped/);
    expect(voiceGreeting(projectSession([...call('live_1', 'connection_lost'), ...call('live_2', 'user_hangup')]))).not.toMatch(/line dropped/);
  });

  it('greets first and asks for the next missing thing', () => {
    expect(voiceGreeting(projectSession([]))).toMatch(/^Greet the caller now in the language they have been using \(English if unsure\)\. .*ask what you should call them/);
    expect(voiceGreeting(projectSession(named))).toMatch(/as Max\..*ask what they would most like a hand with/);
  });

  it('seeds history as a developer context message plus turns within the documented limits', () => {
    const many: SessionEvent[] = Array.from({ length: 200 }, (_, index) => ({ id: `m${index}`, at: 'x', type: 'message', speaker: index % 2 ? 'assistant' : 'user', channel: 'text', text: 'word '.repeat(150) }));
    const input = voiceInput(projectSession(many), []);
    expect(input[0]).toMatchObject({ type: 'message', role: 'developer' });
    expect(input.length).toBeLessThanOrEqual(128);
    const tokens = input.reduce((sum, message) => sum + estimateTokens(message.content[0].text), 0);
    expect(tokens).toBeLessThanOrEqual(6_000);
    expect(input.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'output_text' }] });
    expect(input[1]).toMatchObject({ content: [{ type: expect.stringMatching(/input_text|output_text/) }] });
  });

  it('delegates to gpt-6-luna with JSON-schema tools, and can switch delegation off', () => {
    const { session, delegation } = buildLiveSession(projectSession(named), { OPENAI_VOICE: 'cedar' }, { gmail: true, calendar: true });
    expect(delegation).toBe(true);
    expect(session.audio.output.voice).toBe('cedar');
    const responses = (session as unknown as { delegation: { responses: { model: string; tool_choice: string; parallel_tool_calls: boolean; tools: Array<{ type: string; name: string; parameters: Record<string, unknown> }> } } }).delegation.responses;
    expect(responses).toMatchObject({ model: 'gpt-6-luna', tool_choice: 'auto', parallel_tool_calls: false });
    expect(responses.tools.map((tool) => tool.name)).toEqual(['remember', 'customize', 'note_decline', 'show_connection', 'search_gmail', 'read_calendar_window']);
    expect(responses.tools[0].parameters).toMatchObject({ type: 'object', properties: { key: { enum: ['preferred_name', 'current_need'] } } });
    expect(responses.tools[1].parameters).toMatchObject({ type: 'object', properties: { name: { type: 'string' }, avatar: { type: 'string' }, personality: { type: 'string' }, voice: { enum: ['marin', 'willow', 'ripple', 'stone'] } } });
    expect(session.instructions).toContain('- customize: change your name, look, personality or call voice');
    expect(responses.tools[0].parameters).not.toHaveProperty('$schema');
    const off = buildLiveSession(projectSession([]), { OPENAI_VOICE_DELEGATION: 'off' }, { gmail: true, calendar: true });
    expect(off.delegation).toBe(false);
    expect(off.session).not.toHaveProperty('delegation');
    expect(off.session.instructions).not.toContain('search_gmail');
    expect(off.session.instructions).not.toContain('remember:');
    expect(off.session.instructions).not.toContain('customize:');
    expect(off.session.instructions).toContain('There is no backend on this call.');
  });

});

describe('call personality and voice', () => {
  it('speaks in the chosen voice and personality, and passes the personality to the backend', () => {
    const chosen: SessionEvent[] = [
      ...named,
      { id: 's1', at: 'x', type: 'fact', key: 'personality', value: 'playful', evidence: 'confirmed', provenance: 'user_confirmed', sourceEventId: 'customize:1' },
      { id: 's2', at: 'x', type: 'fact', key: 'voice', value: 'ripple', evidence: 'confirmed', provenance: 'user_confirmed', sourceEventId: 'customize:1' },
    ];
    const live = buildLiveSession(projectSession(chosen), { OPENAI_VOICE: 'marin' }, { gmail: true, calendar: false });
    expect(live.session.audio.output.voice).toBe('ripple');
    expect(live.session.instructions).toMatch(/Personality: playful/);
    expect(live.session.delegation?.responses.instructions).toMatch(/Personality: playful/);
    expect(buildLiveSession(projectSession(named), { OPENAI_VOICE: 'cedar' }, { gmail: true, calendar: false }).session.audio.output.voice).toBe('cedar');
  });
});
