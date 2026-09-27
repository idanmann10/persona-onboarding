import { describe, expect, it } from 'vitest';
import type { SimStages } from '../../evals/sim/score';
import { personaLine, summaryLines, type SimRow } from '../../evals/sim/summary';

const stages: SimStages = {
  named: false, knowsUser: false, needKnown: false, callOffered: false, callHappened: false, gmailConnected: false, calendarConnected: false,
  firstValue: false, taskProposed: false, activated: false, briefComplete: false, stayed: true, turns: 0,
};
const row = (partial: Partial<SimRow>): SimRow => ({
  personaId: 'busy_founder', attempt: 1, status: 'left', leave: { feeling: 'satisfied', reason: 'done' }, stages, judge: null, harnessErrors: 0, invariantFailures: [], durationMs: 1_000, ...partial,
});

describe('sim summary', () => {
  it('prints one line per conversation', () => {
    expect(personaLine(row({ stages: { ...stages, stayed: true, activated: true, turns: 9 }, judge: { formLike: 0.21, pushy: 0.05, ignoredUser: 0.3, human: 3.84, humanConfidence: 0.7 } })))
      .toMatch(/^busy_founder #1 +left satisfied +stayed yes {2}activated yes {2}brief no {3}turns {2}9 {2}form 0\.21 pushy 0\.05 ignored 0\.30 human 3\.8$/);
    expect(personaLine(row({ status: 'error', leave: undefined, stages: null, error: 'The reply turn timed out after 120s' })))
      .toMatch(/^busy_founder #1 +ERROR +The reply turn timed out after 120s$/);
    expect(personaLine(row({ invariantFailures: ['no_call_started_claim'] }))).toMatch(/HARD: no_call_started_claim$/);
  });

  it('totals rates over the conversations that say something about the app, and averages the judge where it answered', () => {
    const rows = [
      row({ stages: { ...stages, stayed: true, activated: true, firstValue: true, turns: 10 }, judge: { formLike: 0.2, pushy: 0.1, ignoredUser: 0.4, human: 4, humanConfidence: 0.8 } }),
      row({ attempt: 2, stages: { ...stages, stayed: false, turns: 4 }, judge: { formLike: 0.6, pushy: null, ignoredUser: 0.2, human: 2, humanConfidence: 0.5 }, harnessErrors: 2 }),
      // An app failure counts against the app.
      row({ attempt: 3, status: 'error', errorSource: 'app', stages: null, invariantFailures: ['no_false_completed_write'] }),
    ];
    expect(summaryLines(rows)).toEqual([
      'Conversations: 3, mean 7.0 actions each',
      '  stayed              1/3  33%',
      '  activated           1/3  33%',
      '  briefComplete       0/3  0%',
      '  firstValue          1/3  33%',
      '  gmailConnected      0/3  0%',
      '  callHappened        0/3  0%',
      'Judge (n=2): form_like 0.40  pushy 0.10  ignored_user 0.30  human 3.00/5',
      'Errors: 1 app failure(s), 0 simulated-user or harness failure(s); 2 action(s) not applied; 1 hard invariant failure(s)',
    ]);
    // A failure on the simulated user's side says nothing about the app: it is left out of the rates.
    const withUserFailure = summaryLines([...rows, row({ attempt: 4, status: 'error', errorSource: 'user', stages: { ...stages, stayed: false, turns: 3 } })]);
    expect(withUserFailure[0]).toBe('Conversations: 4 (1 left out of the rates: the simulated user or the harness failed), mean 7.0 actions each');
    expect(withUserFailure[1]).toBe('  stayed              1/3  33%');
    expect(withUserFailure.at(-1)).toBe('Errors: 1 app failure(s), 1 simulated-user or harness failure(s); 2 action(s) not applied; 1 hard invariant failure(s)');
    expect(summaryLines([row({})]).at(-2)).toBe('Judge: none (no TYPESAFE_API_KEY, or every request failed)');
    expect(personaLine(row({ status: 'error', errorSource: 'user', stages: null, error: 'Anthropic API failed after 3 attempts (HTTP 529)' }))).toMatch(/ERROR user +Anthropic API failed/);
  });
});
