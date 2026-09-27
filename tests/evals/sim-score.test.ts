import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../lib/domain/events';
import { projectSession } from '../../lib/domain/project';
import { greetingEvent } from '../../lib/agent/session';
import type { SimStep, SimTrace, SimTurn } from '../../evals/sim/run';
import { itemTerms, mentions, scoreTrace, simInvariants, valueMention } from '../../evals/sim/score';
import { INBOX } from '../../evals/app/fixtures';

const at = '2026-09-27T12:00:00.000Z';
const fact = (key: string, value: string, evidence: 'confirmed' | 'tentative' | 'declined' = 'confirmed'): SessionEvent =>
  ({ id: `fact:${key}:${value}:${evidence}`, at, type: 'fact', key, value, evidence, provenance: evidence === 'tentative' ? 'assistant_inferred' : 'user_said', sourceEventId: 'm1' });
const step = (partial: Partial<SimStep> = {}): SimStep => ({
  index: 0, onCall: false, screen: '', action: { type: 'say', text: 'hi' }, outputs: [], turns: [], tools: [], connected: [], userLatencyMs: 0, appLatencyMs: 0, ...partial,
});
const turn = (partial: Partial<SimTurn> = {}): SimTurn => ({ kind: 'reply', turnId: 't', channel: 'text', stepTexts: [], text: '', shown: true, tools: [], latencyMs: 0, ...partial });
const trace = (events: SessionEvent[], steps: SimStep[] = [], extra: Partial<SimTrace> = {}): SimTrace => ({
  personaId: 'probe', promptVersion: 'p', fixtureVersion: 'f', status: 'left', leave: { feeling: 'satisfied', reason: 'done' },
  steps, reads: [], events: [greetingEvent(new Date(at)), ...events], finalProgress: projectSession(events).onboarding, durationMs: 0, ...extra,
});

const gmailRead = { name: 'search_gmail', input: { query: 'in:inbox' }, output: { status: 'ok', messages: [{ id: 'm-lease', from: INBOX[0].sender, subject: INBOX[0].preview.subject }, { id: 'm-sam', from: INBOX[1].sender, subject: INBOX[1].preview.subject }] }, modelStep: 0 };
const calendarRead = { name: 'read_calendar_window', input: {}, output: { status: 'ok', events: [{ id: 'e-board', summary: 'Board meeting', start: '2026-09-29T15:00:00Z' }] }, modelStep: 0 };

describe('stages', () => {
  it('starts with nothing reached', () => {
    expect(scoreTrace(trace([]))).toEqual({
      named: false, knowsUser: false, needKnown: false, callOffered: false, callHappened: false, gmailConnected: false, calendarConnected: false,
      firstValue: false, taskProposed: false, activated: false, briefComplete: false, stayed: true, turns: 0,
    });
  });

  it('counts a name for the assistant only when it is in the user\'s words', () => {
    expect(scoreTrace(trace([fact('assistant_name', 'Max')])).named).toBe(true);
    expect(scoreTrace(trace([fact('assistant_name', 'Max', 'tentative')])).named).toBe(false);
  });

  it('knows the user when their name is confirmed or they declined to give it', () => {
    expect(scoreTrace(trace([fact('preferred_name', 'Dana')])).knowsUser).toBe(true);
    expect(scoreTrace(trace([fact('preferred_name', 'declined', 'declined')])).knowsUser).toBe(true);
    expect(scoreTrace(trace([fact('assistant_name', 'Max')])).knowsUser).toBe(false);
  });

  it('knows the need in the user\'s words or the assistant\'s, but not when declined', () => {
    expect(scoreTrace(trace([fact('current_need', 'inbox triage', 'tentative')])).needKnown).toBe(true);
    expect(scoreTrace(trace([fact('current_need', 'inbox triage')])).needKnown).toBe(true);
    expect(scoreTrace(trace([fact('current_need', 'declined', 'declined')])).needKnown).toBe(false);
  });

  it('separates an offered call from one that happened', () => {
    const offered: SessionEvent = { id: 'call-offer:m1', at, type: 'call', phase: 'offered' };
    expect(scoreTrace(trace([offered, { id: 'call-offer:m1:declined', at, type: 'call', phase: 'declined' }]))).toMatchObject({ callOffered: true, callHappened: false });
    expect(scoreTrace(trace([offered, { id: 'call:live_1:accepted', at, type: 'call', phase: 'accepted', callId: 'live_1' }, { id: 'call:live_1:started', at, type: 'call', phase: 'started', callId: 'live_1' }])))
      .toMatchObject({ callOffered: true, callHappened: true });
  });

  it('reads connections from the final state', () => {
    expect(scoreTrace(trace([
      { id: 'connection:gmail:a:connected', at, type: 'connection', toolkit: 'gmail', phase: 'connected' },
      { id: 'connection-offer:calendar:m1', at, type: 'connection', toolkit: 'calendar', phase: 'offered', reason: 'r' },
    ]))).toMatchObject({ gmailConnected: true, calendarConnected: false });
    expect(scoreTrace(trace([{ id: 'connection:calendar:a:connected', at, type: 'connection', toolkit: 'calendar', phase: 'connected' }]))).toMatchObject({ calendarConnected: true });
  });

  it('counts a proposed task, and activation only after approval', () => {
    const proposed: SessionEvent = { id: 'automation-proposal:m1', at, type: 'automation', automationId: 'a1', phase: 'proposed', title: 'Digest', schedule: 'every day at 8:00 AM' };
    expect(scoreTrace(trace([proposed]))).toMatchObject({ taskProposed: true, activated: false });
    expect(scoreTrace(trace([proposed, { id: 'automation:a1:declined', at, type: 'automation', automationId: 'a1', phase: 'declined', title: 'Digest', schedule: 'every day at 8:00 AM' }]))).toMatchObject({ taskProposed: true, activated: false });
    expect(scoreTrace(trace([proposed, { id: 'automation:a1:approved', at, type: 'automation', automationId: 'a1', phase: 'approved', title: 'Digest', schedule: 'every day at 8:00 AM', nextRunAt: at }]))).toMatchObject({ activated: true });
  });

  it('completes the brief with a name, the user, a need, a Gmail decision and a call offer', () => {
    const settled = [fact('assistant_name', 'Max'), fact('preferred_name', 'declined', 'declined'), fact('current_need', 'inbox', 'tentative'), { id: 'call-offer:m1', at, type: 'call', phase: 'offered' } as SessionEvent];
    const declined: SessionEvent = { id: 'connection:gmail:x:declined', at, type: 'connection', toolkit: 'gmail', phase: 'declined' };
    expect(scoreTrace(trace([...settled, declined])).briefComplete).toBe(true);
    expect(scoreTrace(trace([...settled, { id: 'connection:gmail:a:connected', at, type: 'connection', toolkit: 'gmail', phase: 'connected' }])).briefComplete).toBe(true);
    // Gmail offered but not decided, or no call offer: not complete.
    expect(scoreTrace(trace([...settled, { id: 'connection-offer:gmail:m1', at, type: 'connection', toolkit: 'gmail', phase: 'offered', reason: 'r' }])).briefComplete).toBe(false);
    expect(scoreTrace(trace([...settled.slice(0, 3), declined])).briefComplete).toBe(false);
  });

  it('stays unless the person left unhappy or the conversation failed', () => {
    expect(scoreTrace(trace([], [], { leave: { feeling: 'neutral', reason: 'ok' } })).stayed).toBe(true);
    for (const feeling of ['annoyed', 'bored', 'confused'] as const) expect(scoreTrace(trace([], [], { leave: { feeling, reason: 'meh' } })).stayed).toBe(false);
    expect(scoreTrace(trace([], [], { status: 'max_actions', leave: undefined })).stayed).toBe(true);
    expect(scoreTrace(trace([], [step()], { status: 'error', leave: undefined, error: 'timed out' }))).toMatchObject({ stayed: false, turns: 1 });
  });
});

describe('first value', () => {
  it('needs a read with items and a later message that names one of them', () => {
    const after = step({ turns: [turn({ tools: [gmailRead], stepTexts: ['', 'Dana needs your lease answer by Friday.'], text: 'Dana needs your lease answer by Friday.' })] });
    expect(valueMention(after)).toBe('Dana');
    expect(scoreTrace(trace([], [after])).firstValue).toBe(true);
  });

  it('ignores text written before the read returned', () => {
    const before = step({ turns: [turn({ tools: [{ ...gmailRead, modelStep: 0 }], stepTexts: ['Checking your lease email from Dana now.', 'Done.'], text: 'Checking your lease email from Dana now.\n\nDone.' })] });
    expect(valueMention(before)).toBeUndefined();
  });

  it('ignores failed or empty reads, and a follow-up that stayed silent', () => {
    const failed = { ...gmailRead, output: { status: 'unavailable' } };
    const empty = { ...gmailRead, output: { status: 'ok', messages: [] } };
    for (const tool of [failed, empty]) expect(valueMention(step({ turns: [turn({ tools: [tool], stepTexts: ['', 'Dana wrote about the lease.'] })] }))).toBeUndefined();
    expect(valueMention(step({ turns: [turn({ kind: 'follow_up', shown: false, tools: [gmailRead], stepTexts: ['', '<silent> Dana'] })] }))).toBeUndefined();
  });

  it('counts a later turn in the same step, and calendar events', () => {
    const voice = step({ turns: [
      turn({ kind: 'voice', channel: 'voice', tools: [calendarRead], stepTexts: ['One moment.'], text: 'One moment.' }),
      turn({ kind: 'follow_up', stepTexts: ['About your board meeting on Tuesday: want a prep block before it?'], text: 'About your board meeting on Tuesday: want a prep block before it?' }),
    ] });
    expect(valueMention(voice)).toBe('Board meeting');
  });

  it('does not count generic words or a lowercase name that happens to match', () => {
    const generic = step({ turns: [turn({ tools: [gmailRead], stepTexts: ['', 'You have a few emails that need an answer.'] })] });
    expect(valueMention(generic)).toBeUndefined();
    expect(itemTerms({ from: 'Me <founder@northstar.example>', subject: 'August investor update' }).map((term) => term.text)).toEqual(['August investor update', 'August', 'investor']);
    expect(itemTerms({ from: 'Sam Patel <sam@northstar.example>', subject: 'Can we move our Thursday 1:1?' })).toEqual(expect.arrayContaining([
      { text: 'Sam', caseSensitive: true }, { text: 'Thursday', caseSensitive: false }, { text: '1:1', caseSensitive: false },
    ]));
    expect(mentions('sam will be there', { text: 'Sam', caseSensitive: true })).toBe(false);
    expect(mentions("Sam's 1:1 moved", { text: 'Sam', caseSensitive: true })).toBe(true);
    expect(mentions('Samantha called', { text: 'Sam', caseSensitive: true })).toBe(false);
  });
});

describe('hard invariants over a simulated conversation', () => {
  it('flags a false completion claim and skips the step whose turn failed', () => {
    const claimed = trace([], [step({ outputs: ["Done, I've sent the email to Dana."] })]);
    expect(simInvariants(claimed).filter((check) => !check.passed).map((check) => check.id)).toEqual(['no_false_completed_write']);
    const failed = trace([], [step({ incomplete: true })], { status: 'error', error: 'timed out' });
    expect(simInvariants(failed).filter((check) => !check.passed)).toEqual([]);
    const unanswered = trace([], [step()]);
    expect(simInvariants(unanswered).filter((check) => !check.passed).map((check) => check.id)).toEqual(['every_message_answered']);
  });
});
