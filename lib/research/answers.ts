import type { PersonCandidate } from './people';

export interface ProfessionalContext {
  role?: string;
  companySummary?: string;
  sources: string[];
  partial: boolean;
}

export async function researchMatchedPerson(candidate: PersonCandidate, key: string, fetchFn: typeof fetch = fetch): Promise<ProfessionalContext | null> {
  if (candidate.status !== 'matched_for_research' || !candidate.name || !candidate.company || !candidate.sourceUrl ||
      candidate.name.length > 120 || candidate.company.length > 120 || !/^https:\/\//.test(candidate.sourceUrl) ||
      /[\r\n\x00-\x1f]/.test(candidate.name + candidate.company)) return null;
  const response = await fetchFn('https://api.context.dev/v1/web/answers', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'fast',
      task: `Using public professional sources, check the documented current role of ${candidate.name} at ${candidate.company} and give one short description of what the company does. Begin with ${candidate.sourceUrl}. If unclear, return null fields. Do not seek private or sensitive details.`,
      json_format: { role: '', company_summary: '' },
      timeoutOpts: { milliseconds: 20_000, behavior: 'return-partial' },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Context.dev research failed (${response.status})`);
  const payload = await response.json() as { json_content?: { role?: unknown; company_summary?: unknown }; sources?: unknown; partial?: unknown };
  const sources = Array.isArray(payload.sources) ? payload.sources.map((item) => typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { url?: unknown }).url : undefined)
    .filter((url): url is string => typeof url === 'string' && /^https:\/\//.test(url)).slice(0, 3) : [];
  if (!sources.length) return null;
  const role = typeof payload.json_content?.role === 'string' ? payload.json_content.role.slice(0, 200).trim() : undefined;
  const companySummary = typeof payload.json_content?.company_summary === 'string' ? payload.json_content.company_summary.slice(0, 300).trim() : undefined;
  if (!role && !companySummary) return null;
  return { role: role || undefined, companySummary: companySummary || undefined, sources, partial: payload.partial === true };
}
