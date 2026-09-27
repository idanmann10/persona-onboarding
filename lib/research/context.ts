import { assessIdentity, type Provenance } from '../domain/knowledge';

export interface PersonClue {
  first: string;
  last: string;
  company?: string;
  provenance: Provenance;
}

export interface PersonCandidate {
  status: 'candidate' | 'matched_for_research';
  score: number;
  name?: string;
  company?: string;
  sourceUrl?: string;
  requestId?: string;
}

const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

export async function lookupPersonCandidate(clue: PersonClue, key: string, fetchFn: typeof fetch = fetch): Promise<PersonCandidate | null> {
  if (!clue.first?.trim() || !clue.last?.trim() || !clue.company?.trim() || clue.provenance === 'assistant_inferred') return null;
  const response = await fetchFn('https://api.context.dev/v1/people/enrich', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: { first: clue.first.trim(), last: clue.last.trim() }, company: { name: clue.company.trim() } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Context.dev lookup failed (${response.status})`);
  const payload = await response.json() as {
    match?: { status?: string; score?: number; person?: {
      name?: { full?: string };
      current_role_status?: string;
      current_role?: { organization?: { name?: string } };
      social_urls?: string[];
    } };
    request_id?: string;
  };
  if (payload.match?.status !== 'candidate' || !payload.match.person) return null;
  const person = payload.match.person;
  const score = typeof payload.match.score === 'number' ? payload.match.score / 100 : 0;
  const nameMatches = normalized(person.name?.full || '') === normalized(`${clue.first} ${clue.last}`);
  const companyMatches = person.current_role_status === 'present' &&
    normalized(person.current_role?.organization?.name || '') === normalized(clue.company);
  const sourceUrl = person.social_urls?.find((url) => /^https:\/\//.test(url));
  const status = sourceUrl && nameMatches && companyMatches
    ? assessIdentity({ name: person.name?.full, company: clue.company, provenance: clue.provenance, matchScore: score, corroboratingSignals: 2, competingCandidates: 0 })
    : 'candidate';
  return {
    status: status === 'matched_for_research' && score >= 0.95 ? status : 'candidate',
    score,
    name: person.name?.full,
    company: person.current_role?.organization?.name,
    sourceUrl,
    requestId: payload.request_id,
  };
}
