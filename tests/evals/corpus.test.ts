import { describe, expect, it } from 'vitest';
import cases from '../../evals/cases/base.json';
import { parseCorpus } from '../../evals/cases/schema';

const groups = [
  'entry_intent', 'pace_trust', 'channel_switch', 'identity',
  'connection', 'tool_action', 'correction_memory', 'automation_abuse',
] as const;

describe('Persona scenario corpus', () => {
  it('contains 48 unique, actionable synthetic cases, six in each group', () => {
    const parsed = parseCorpus(cases);
    expect(parsed).toHaveLength(48);
    expect(new Set(parsed.map((item) => item.id)).size).toBe(48);
    for (const group of groups) {
      expect(parsed.filter((item) => item.group === group)).toHaveLength(6);
    }
    expect(parsed.every((item) => item.turns.length > 0 && item.expected.length > 0)).toBe(true);
  });

  it('rejects duplicate IDs and cases with no expected outcome', () => {
    const duplicate = [cases[0], cases[0]];
    expect(() => parseCorpus(duplicate)).toThrow(/duplicate/i);
    expect(() => parseCorpus([{ ...cases[0], expected: [] }])).toThrow();
  });
});
