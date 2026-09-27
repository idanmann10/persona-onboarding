export type Evidence = 'tentative' | 'confirmed' | 'declined' | 'superseded';
export type Provenance = 'user_said' | 'tool_observed' | 'assistant_inferred' | 'user_confirmed';

export interface KnowledgeFact {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  evidence: Evidence;
  provenance: Provenance;
  sourceUrl?: string;
  taskTags: string[];
}

export interface IdentityEvidence {
  name?: string;
  company?: string;
  provenance: Provenance;
  matchScore: number;
  corroboratingSignals: number;
  competingCandidates: number;
}

export type IdentityStatus = 'clue' | 'candidate' | 'matched_for_research';

export function assessIdentity(input: IdentityEvidence): IdentityStatus {
  if (!input.name?.trim() || input.provenance === 'assistant_inferred') return 'clue';
  if (!input.company?.trim() || input.corroboratingSignals < 1) return 'clue';
  if (input.competingCandidates > 0 || input.matchScore < 0.9 || input.corroboratingSignals < 2) return 'candidate';
  return 'matched_for_research';
}

export function selectRelevantFacts(facts: KnowledgeFact[], tags: string[]): KnowledgeFact[] {
  return facts.filter((fact) =>
    fact.evidence !== 'superseded' &&
    fact.evidence !== 'declined' &&
    fact.taskTags.some((tag) => tags.includes(tag)),
  );
}
