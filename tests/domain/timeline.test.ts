import { describe, expect, it } from 'vitest';
import { projectSession } from '../../lib/domain/project';
import type { SessionEvent } from '../../lib/domain/events';

const at = (second: number) => `2026-09-27T12:00:${String(second).padStart(2, '0')}.000Z`;

describe('conversation timeline and onboarding progress', () => {
  it('starts with nothing known and nothing offered', () => {
    expect(projectSession([]).onboarding).toEqual({
      assistantName: { status: 'unknown' }, preferredName: { status: 'unknown' }, need: { status: 'unknown' }, gmail: 'not_offered', call: 'not_offered',
      automation: { status: 'none' },
    });
  });

  it('tracks names, a need, declines, and a call that happened', () => {
    const events: SessionEvent[] = [
      { id: 'm1', at: at(1), type: 'message', speaker: 'user', channel: 'text', text: 'Call yourself Max' },
      { id: 'f1', at: at(2), type: 'fact', key: 'assistant_name', value: 'Max', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm1' },
      { id: 'o1', at: at(3), type: 'call', phase: 'offered' },
      { id: 'call:live_1:accepted', at: at(4), type: 'call', phase: 'accepted', callId: 'live_1' },
      { id: 'call:live_1:started', at: at(5), type: 'call', phase: 'started', callId: 'live_1' },
      { id: 'voice:live_1:e1', at: at(6), type: 'voice_fragment', callId: 'live_1', speaker: 'user', text: "I'd rather not give my name", startMs: 100, endMs: 900, final: false },
      { id: 'f2', at: at(7), type: 'fact', key: 'preferred_name', value: 'declined', evidence: 'declined', provenance: 'user_said', sourceEventId: 'x' },
      { id: 'f3', at: at(8), type: 'fact', key: 'current_need', value: 'inbox triage', evidence: 'tentative', provenance: 'assistant_inferred', sourceEventId: 'x' },
      { id: 'call:live_1:ended', at: at(40), type: 'call', phase: 'ended', callId: 'live_1', reason: 'user_hangup' },
    ];
    const state = projectSession(events);
    expect(state.onboarding).toEqual({
      assistantName: { status: 'confirmed', value: 'Max' }, preferredName: { status: 'declined' }, need: { status: 'tentative', value: 'inbox triage' },
      gmail: 'not_offered', call: 'happened', automation: { status: 'none' },
    });
    expect(state.timeline.map((item) => item.kind)).toEqual(['message', 'call_offer', 'call']);
    const offer = state.timeline[1];
    expect(offer.kind === 'call_offer' && offer.status).toBe('answered');
    const call = state.calls[0];
    expect(call).toMatchObject({ callId: 'live_1', phase: 'ended', reason: 'user_hangup', startedAt: at(5), endedAt: at(40) });
    expect(call.utterances.map((utterance) => utterance.text)).toEqual(["I'd rather not give my name"]);
  });

  it('marks a declined call offer and a connection card lifecycle', () => {
    const state = projectSession([
      { id: 'o1', at: at(1), type: 'call', phase: 'offered' },
      { id: 'o1:declined', at: at(2), type: 'call', phase: 'declined' },
      { id: 'c1', at: at(3), type: 'connection', toolkit: 'gmail', phase: 'offered', reason: 'See who is waiting on you' },
      { id: 'c2', at: at(4), type: 'connection', toolkit: 'gmail', phase: 'connected' },
    ]);
    expect(state.onboarding.call).toBe('declined');
    expect(state.onboarding.gmail).toBe('connected');
    expect(state.timeline).toEqual([
      { kind: 'call_offer', id: 'o1', status: 'declined' },
      { kind: 'connection_offer', id: 'c1', toolkit: 'gmail', status: 'connected', reason: 'See who is waiting on you' },
      { kind: 'connection_notice', id: 'c2', toolkit: 'gmail', phase: 'connected' },
    ]);
  });

  it('does not count a call that never connected as having happened', () => {
    const state = projectSession([
      { id: 'call:live_2:accepted', at: at(1), type: 'call', phase: 'accepted', callId: 'live_2' },
      { id: 'call:live_2:dropped', at: at(2), type: 'call', phase: 'dropped', callId: 'live_2', reason: 'setup_failed' },
    ]);
    expect(state.onboarding.call).toBe('not_offered');
    expect(state.calls[0]).toMatchObject({ phase: 'dropped', reason: 'setup_failed' });
  });

  it('records follow-up decisions', () => {
    const state = projectSession([{ id: 'd1', at: at(1), type: 'decision', trigger: 'followup:call:live_1', outcome: 'silent' }]);
    expect(state.decisions).toEqual({ 'followup:call:live_1': 'silent' });
  });

  it("places a card a tool created mid-turn after that turn's reply", () => {
    const state = projectSession([
      { id: 'm1', at: at(1), type: 'message', speaker: 'user', channel: 'text', text: 'sure, call me' },
      { id: 'call-offer:m1', at: at(2), type: 'call', phase: 'offered' },
      { id: 'connection-offer:gmail:m1', at: at(2), type: 'connection', toolkit: 'gmail', phase: 'offered' },
      { id: 'answer:m1', at: at(3), type: 'message', speaker: 'assistant', channel: 'text', text: 'Tap Answer below.' },
      { id: 'connection-offer:gmail:live_1:call_2', at: at(4), type: 'connection', toolkit: 'gmail', phase: 'offered' },
    ]);
    expect(state.timeline.map((item) => item.id)).toEqual(['m1', 'answer:m1', 'call-offer:m1', 'connection-offer:gmail:m1', 'connection-offer:gmail:live_1:call_2']);
  });

  it('tracks an automation from preview card to active schedule, after the reply that proposed it', () => {
    const state = projectSession([
      { id: 'm1', at: at(1), type: 'message', speaker: 'user', channel: 'text', text: 'send me this every weekday morning' },
      { id: 'automation-proposal:m1', at: at(2), type: 'automation', automationId: 'a1', phase: 'proposed', title: 'Morning inbox rundown', schedule: 'every weekday at 8:00 AM', instruction: 'List emails waiting on my reply.' },
      { id: 'answer:m1', at: at(3), type: 'message', speaker: 'assistant', channel: 'text', text: 'Here is a preview. Approve it and it starts tomorrow.' },
      { id: 'automation:a1:approved', at: at(4), type: 'automation', automationId: 'a1', phase: 'approved', title: 'Morning inbox rundown', schedule: 'every weekday at 8:00 AM', nextRunAt: '2026-09-28T12:00:00.000Z' },
      { id: 'automation:a1:failed:r1', at: at(5), type: 'automation', automationId: 'a1', phase: 'failed', title: 'Morning inbox rundown', schedule: 'every weekday at 8:00 AM' },
    ]);
    expect(state.timeline.map((item) => item.kind)).toEqual(['message', 'message', 'automation', 'automation_notice']);
    expect(state.timeline[2]).toMatchObject({ status: 'active', nextRunAt: '2026-09-28T12:00:00.000Z' });
    expect(state.onboarding.automation).toEqual({ status: 'active', title: 'Morning inbox rundown', schedule: 'every weekday at 8:00 AM' });
  });
});
