import { describe, expect, it } from 'vitest';
import { describeTrigger, isSilent } from '../../lib/agent/follow-up';
import { projectSession } from '../../lib/domain/project';
import type { CallEndReason, SessionEvent } from '../../lib/domain/events';

const call = (reason: CallEndReason, lastWords: string, lastSpeaker: 'user' | 'assistant' = 'user'): SessionEvent[] => [
  { id: 'call:live_1:accepted', at: '2026-09-27T12:00:00.000Z', type: 'call', phase: 'accepted', callId: 'live_1' },
  { id: 'call:live_1:started', at: '2026-09-27T12:00:01.000Z', type: 'call', phase: 'started', callId: 'live_1' },
  { id: 'voice:live_1:a', at: 'x', type: 'voice_fragment', callId: 'live_1', speaker: 'assistant', text: "What's eating most of your time?", startMs: 0, endMs: 1_000, final: false },
  { id: 'voice:live_1:b', at: 'x', type: 'voice_fragment', callId: 'live_1', speaker: lastSpeaker, text: lastWords, startMs: 2_000, endMs: 3_000, final: false },
  { id: `call:live_1:${reason === 'connection_lost' ? 'dropped' : 'ended'}`, at: '2026-09-27T12:02:15.000Z', type: 'call', phase: reason === 'connection_lost' ? 'dropped' : 'ended', callId: 'live_1', reason },
];

describe('follow-up triggers', () => {
  it('names a mid-sentence hangup and forbids inventing the rest', () => {
    const trigger = describeTrigger(projectSession(call('user_hangup', 'honestly the investor updates, every month I have to')), { kind: 'call_ended', callId: 'live_1' });
    expect(trigger?.id).toBe('followup:call:live_1');
    expect(trigger?.instruction).toContain('ended because the user hung up, after 2 min 14s');
    expect(trigger?.instruction).toContain('cut off mid-sentence: "honestly the investor updates, every month I have to"');
    expect(trigger?.instruction).toMatch(/Do not invent what they were about to say/);
    expect(trigger?.instruction).toMatch(/don't push another call/);
  });

  it('offers a call-back after a drop, and allows silence after a natural goodbye', () => {
    const dropped = describeTrigger(projectSession(call('connection_lost', 'so the thing is')), { kind: 'call_ended', callId: 'live_1' });
    expect(dropped?.instruction).toMatch(/offer to call back/);
    const goodbye = describeTrigger(projectSession(call('remote_hangup', 'Thanks, bye!')), { kind: 'call_ended', callId: 'live_1' });
    expect(goodbye?.instruction).not.toMatch(/cut off/);
    expect(goodbye?.instruction).toContain('reply with exactly <silent>');
  });

  it('waits for a live call to end and handles a call that never connected', () => {
    const live = projectSession(call('user_hangup', 'hi').slice(0, 3));
    expect(describeTrigger(live, { kind: 'call_ended', callId: 'live_1' })).toBeUndefined();
    const failed = projectSession([
      { id: 'call:live_2:accepted', at: 'x', type: 'call', phase: 'accepted', callId: 'live_2' },
      { id: 'call:live_2:dropped', at: 'x', type: 'call', phase: 'dropped', callId: 'live_2', reason: 'setup_failed' },
    ]);
    expect(describeTrigger(failed, { kind: 'call_ended', callId: 'live_2' })?.instruction).toMatch(/never connected/);
  });

  it('reacts to a confirmed connection with value, and to a failure without blame', () => {
    const connected = projectSession([{ id: 'connection:gmail:a1:connected', at: 'x', type: 'connection', toolkit: 'gmail', phase: 'connected' }]);
    const trigger = describeTrigger(connected, { kind: 'connection', toolkit: 'gmail' });
    expect(trigger).toMatchObject({ id: 'followup:connection:gmail:a1:connected', include: ['gmail'] });
    expect(trigger?.instruction).toMatch(/search their inbox now/);
    const failed = projectSession([{ id: 'connection:gmail:a2:failed', at: 'x', type: 'connection', toolkit: 'gmail', phase: 'failed' }]);
    expect(describeTrigger(failed, { kind: 'connection', toolkit: 'gmail' })?.instruction).toMatch(/without blame/);
    expect(describeTrigger(projectSession([]), { kind: 'connection', toolkit: 'gmail' })).toBeUndefined();
  });

  it('treats empty or <silent> output as silence', () => {
    expect(isSilent('')).toBe(true);
    expect(isSilent('  <silent>')).toBe(true);
    expect(isSilent('Hey, looks like we got cut off.')).toBe(false);
  });
});
