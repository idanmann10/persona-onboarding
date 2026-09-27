import { describe, expect, it } from 'vitest';
import { assessIdentity, selectRelevantFacts } from '../../lib/domain/knowledge';

describe('knowledge selection and identity matching', () => {
  it('does not research from a lone name or model inference', () => {
    expect(assessIdentity({ name: 'Jordan Lee', provenance: 'assistant_inferred', matchScore: 0.99, corroboratingSignals: 3, competingCandidates: 0 })).not.toBe('matched_for_research');
    expect(assessIdentity({ name: 'Jordan Lee', provenance: 'user_said', matchScore: 0.99, corroboratingSignals: 0, competingCandidates: 0 })).not.toBe('matched_for_research');
  });

  it('requires a unique corroborated person and company match', () => {
    const candidate = { name: 'Jordan Lee', company: 'Northstar Analytics', provenance: 'user_said' as const, matchScore: 0.96, corroboratingSignals: 2 };
    expect(assessIdentity({ ...candidate, competingCandidates: 1 })).toBe('candidate');
    expect(assessIdentity({ ...candidate, competingCandidates: 0 })).toBe('matched_for_research');
  });

  it('retains source links and excludes superseded facts from active recall', () => {
    const facts = selectRelevantFacts([
      { id: 'old', subject: 'user', predicate: 'company', value: 'Old Co', evidence: 'superseded', provenance: 'user_said', taskTags: ['work'] },
      { id: 'new', subject: 'user', predicate: 'company', value: 'Northstar Analytics', evidence: 'confirmed', provenance: 'user_said', taskTags: ['work'] },
      { id: 'public', subject: 'Northstar Analytics', predicate: 'industry', value: 'analytics', evidence: 'tentative', provenance: 'tool_observed', sourceUrl: 'https://example.org/company', taskTags: ['work'] },
    ], ['work']);
    expect(facts.map((fact) => fact.id)).toEqual(['new', 'public']);
    expect(facts[1].sourceUrl).toBe('https://example.org/company');
  });
});
