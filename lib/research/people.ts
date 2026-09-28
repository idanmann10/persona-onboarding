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

const GENERIC_HANDLES = new Set(['info', 'contact', 'hello', 'hi', 'admin', 'mail', 'email', 'me', 'support', 'team', 'office', 'sales', 'hey', 'inbox', 'test', 'user', 'noreply']);

/** The part of an email before "@", when it's distinctive enough to find someone by (not "info", not just a first name). */
export function distinctiveHandle(email: string, first?: string): string | undefined {
  const handle = email.split('@')[0]?.toLowerCase().replace(/\+.*$/, '');
  if (!handle || handle.length < 5 || !/[a-z]/.test(handle) || GENERIC_HANDLES.has(handle)) return undefined;
  if (first && handle === first.toLowerCase()) return undefined;
  return /^[a-z0-9._-]{5,40}$/.test(handle) ? handle : undefined;
}

export interface HandleProfile { name: string; handle: string; profiles: Array<{ title: string; url: string; snippet: string }>; requestId?: string }

/**
 * A personal email's handle ("idanmann10") is usually their username elsewhere (GitHub, Peerlist...). Only
 * pages that carry both the handle (in the address or text) and the exact full name count: the handle ties
 * them to this person, where a name alone could be anyone. Returns their public profile snippets, or null.
 */
export async function lookupByHandle(fullName: string, handle: string, key: string, fetchFn: typeof fetch = fetch): Promise<HandleProfile | null> {
  const name = fullName.trim().replace(/\s+/g, ' ');
  if (name.split(' ').length < 2) return null;
  const response = await fetchFn('https://api.exa.ai/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `${handle} ${name}`, type: 'auto', numResults: 6, contents: { highlights: true } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Exa handle search failed (${response.status})`);
  const payload = await response.json() as { requestId?: string; results?: ExaResult[] };
  const nameIn = new RegExp(`(^|\\W)${escaped(normalized(name))}(\\W|$)`);
  const profiles = (payload.results ?? []).filter((result) => {
    if (!/^https:\/\//.test(result.url ?? '')) return false;
    const text = normalized([result.title, ...(result.highlights ?? [])].join(' '));
    return (result.url!.toLowerCase().includes(handle) || text.includes(handle)) && nameIn.test(text);
  }).slice(0, 3).map((result) => ({
    title: (result.title ?? '').slice(0, 120),
    url: result.url!,
    snippet: (result.highlights ?? []).join(' ').replace(/[#*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240),
  }));
  return profiles.length ? { name, handle, profiles, requestId: payload.requestId } : null;
}
