import { describe, expect, it } from 'vitest';
import { sessionStages, summarizeFunnel } from '../../lib/domain/funnel';
import type { SessionEvent } from '../../lib/domain/events';

const at = '2026-09-27T12:00:00Z';
const user = (id: string, text: string): SessionEvent => ({ id, at, type: 'message', speaker: 'user', channel: 'text', text });
const fact = (key: string, value: string, evidence: 'confirmed' | 'declined' = 'confirmed'): SessionEvent => ({ id: `f:${key}`, at, type: 'fact', key, value, evidence, provenance: 'user_said', sourceEventId: 'm' });

const activated: SessionEvent[] = [
  user('m1', 'Max'), fact('assistant_name', 'Max'), user('m2', "I'm Dana, my inbox is a mess"), fact('preferred_name', 'Dana'), fact('current_need', 'inbox is a mess'),
  { id: 'offer', at, type: 'call', phase: 'offered' },
  { id: 'c', at, type: 'connection', toolkit: 'gmail', phase: 'connected' },
  { id: 'r', at, type: 'account_read', toolkit: 'gmail', items: 3 },
  { id: 'p', at, type: 'automation', automationId: 'a1', phase: 'proposed', title: 'Morning rundown', schedule: 'every weekday at 8:00 AM' },
  { id: 'ok', at, type: 'automation', automationId: 'a1', phase: 'approved', title: 'Morning rundown', schedule: 'every weekday at 8:00 AM', nextRunAt: at },
  user('m3', 'thanks'),
  { id: 'v', at, type: 'visit' },
];

describe('onboarding funnel', () => {
  it('marks every stage a fully activated session reached', () => {
    expect(sessionStages(activated)).toEqual({
      replied: true, stayed: true, named: true, knowsUser: true, needKnown: true, callOffered: true, callHappened: false,
      gmailConnected: true, setupDone: true, firstValue: true, taskProposed: true, activated: true, returned: true,
    });
  });

  it('counts a declined name as known, an empty read as no value, and a bounce as not staying', () => {
    const stages = sessionStages([user('m1', 'hi'), fact('preferred_name', 'declined', 'declined'), { id: 'r', at, type: 'account_read', toolkit: 'gmail', items: 0 }]);
    expect(stages).toMatchObject({ replied: true, stayed: false, knowsUser: true, firstValue: false, activated: false });
  });

  it('summarizes percentages across sessions', () => {
    const summary = summarizeFunnel([activated, [user('m1', 'hi')], []]);
    expect(summary.sessions).toBe(3);
    expect(summary.stages.find((stage) => stage.stage === 'replied')).toMatchObject({ count: 2, percent: 66.7 });
    expect(summary.stages.find((stage) => stage.stage === 'activated')).toMatchObject({ count: 1, percent: 33.3 });
  });
});
