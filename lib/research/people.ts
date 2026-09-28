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
  /** The profile's own one-line headline ("CEO @ Arlo"), when the match gives one. */
  headline?: string;
  requestId?: string;
}

interface ExaResult { title?: string; url?: string; highlights?: string[] }

const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
// Profile titles look like "Dana Lee", "Dana Lee - Founder - Acme" or "Dana Lee | LinkedIn".
const titleName = (title = '') => normalized(title.split(/\s[-|–—]\s/)[0]);
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "# Dana Lee CEO @ Acme | Building…" → "CEO @ Acme": the profile's headline after the name. */
function headlineOf(result: ExaResult, name: string): string | undefined {
  const first = (result.highlights?.[0] ?? '').replace(/^#+\s*/, '').split(/\n| \| | \.\.\. /)[0].trim();
  const rest = first.toLocaleLowerCase().startsWith(name.toLocaleLowerCase()) ? first.slice(name.length).trim() : '';
  return rest && rest.length <= 100 && !/https?:|[<>\[\]]/.test(rest) ? rest : undefined;
}

/**
 * Looks a stated person up with Exa's people search. It is a match only when exactly one profile carries
 * the stated full name and mentions the stated company; two same-name profiles at that company, or none,
 * leave it a candidate, so research never runs on the wrong person.
 */
export async function lookupPersonCandidate(clue: PersonClue, key: string, fetchFn: typeof fetch = fetch): Promise<PersonCandidate | null> {
  if (!clue.first?.trim() || !clue.last?.trim() || !clue.company?.trim() || clue.provenance === 'assistant_inferred') return null;
  const name = `${clue.first.trim()} ${clue.last.trim()}`;
  const company = clue.company.trim();
  const response = await fetchFn('https://api.exa.ai/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `${name}, ${company}`, category: 'people', type: 'auto', numResults: 5, contents: { highlights: true } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Exa people search failed (${response.status})`);
  const payload = await response.json() as { requestId?: string; results?: ExaResult[] };
  const sameName = (payload.results ?? []).filter((result) => titleName(result.title) === normalized(name) && /^https:\/\//.test(result.url ?? ''));
  if (!sameName.length) return null;
  const mentionsCompany = new RegExp(`(^|\\W)${escaped(normalized(company))}(\\W|$)`);
  const atCompany = sameName.filter((result) => mentionsCompany.test(normalized([result.title, ...(result.highlights ?? [])].join(' '))));
  const score = atCompany.length === 1 ? 1 : atCompany.length ? 0.5 : 0.3;
  const status = assessIdentity({
    name, company, provenance: clue.provenance, matchScore: score,
    corroboratingSignals: atCompany.length ? 2 : 1, competingCandidates: Math.max(0, atCompany.length - 1),
  });
  const best = atCompany[0] ?? sameName[0];
  const headline = atCompany.length === 1 ? headlineOf(best, name) : undefined;
  return {
    status: status === 'matched_for_research' ? status : 'candidate',
    score,
    name,
    company,
    sourceUrl: best.url,
    ...(headline ? { headline } : {}),
    requestId: payload.requestId,
  };
}
