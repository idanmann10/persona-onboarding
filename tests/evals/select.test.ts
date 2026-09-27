import { describe, expect, it } from 'vitest';
import cases from '../../evals/cases/base.json';
import { selectScenarios } from '../../evals/select';

describe('text eval selection', () => {
  it('requires an explicit id or all flag and rejects unknown ids', () => {
    expect(() => selectScenarios(cases, [])).toThrow('Select');
    expect(() => selectScenarios(cases, ['--id', 'missing'])).toThrow('Unknown');
    expect(selectScenarios(cases, ['--id', 'entry_intent_01']).map((item) => item.id)).toEqual(['entry_intent_01']);
    expect(selectScenarios(cases, ['--all'])).toHaveLength(48);
  });
});
