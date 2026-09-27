import type { SessionEvent } from '../domain/events';
import { isDirectIdentityClaim } from './claim';
import { lookupPersonCandidate, type PersonCandidate } from './context';
import { researchMatchedPerson, type ProfessionalContext } from './answers';
import { projectSession } from '../domain/project';

interface Store {
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
}

type Clue = { first: string; last: string; company: string };
type Lookup = typeof lookupPersonCandidate;
type Research = (candidate: PersonCandidate, key: string) => Promise<ProfessionalContext | null>;

export async function resolveIdentityClaim(
  store: Store,
  sessionId: string,
  userEvent: SessionEvent,
  clue: Clue,
  key: string,
  lookup: Lookup = lookupPersonCandidate,
  research: Research = researchMatchedPerson,
): Promise<(PersonCandidate & { research?: ProfessionalContext | null }) | { status: 'insufficient_evidence' | 'already_checked' | 'not_found' }> {
  if (userEvent.type !== 'message' || userEvent.speaker !== 'user' || !isDirectIdentityClaim(userEvent.text, clue)) {
    return { status: 'insufficient_evidence' };
  }
  const checkedId = `identity:${userEvent.id}:lookup`;
  const events = await store.readEvents(sessionId);
  if (events.some((event) => event.id === checkedId)) return { status: 'already_checked' };
  const at = new Date().toISOString();
  const previous = projectSession(events).facts;
  const newName = `${clue.first} ${clue.last}`;
  const changedIdentity = Boolean((previous.name && previous.name.value.toLocaleLowerCase() !== newName.toLocaleLowerCase()) ||
    (previous.company && previous.company.value.toLocaleLowerCase() !== clue.company.toLocaleLowerCase()));
  if (changedIdentity) {
    for (const field of ['public_identity_candidate', 'public_role', 'public_company_summary', 'public_research_status'] as const) {
      if (previous[field]) await store.appendEvent(sessionId, { id: `identity:${userEvent.id}:invalidate:${field}`, at, type: 'fact', key: field, value: 'identity changed', evidence: 'declined', provenance: 'user_said', sourceEventId: userEvent.id });
    }
  }
  await store.appendEvent(sessionId, { id: `identity:${userEvent.id}:name`, at, type: 'fact', key: 'name', value: `${clue.first} ${clue.last}`, evidence: 'confirmed', provenance: 'user_said', sourceEventId: userEvent.id });
  await store.appendEvent(sessionId, { id: `identity:${userEvent.id}:company`, at, type: 'fact', key: 'company', value: clue.company, evidence: 'confirmed', provenance: 'user_said', sourceEventId: userEvent.id });
  const candidate = await lookup({ ...clue, provenance: 'user_said' }, key);
  await store.appendEvent(sessionId, { id: checkedId, at: new Date().toISOString(), type: 'fact', key: 'identity_lookup_status', value: candidate?.status || 'not_found', evidence: 'tentative', provenance: 'tool_observed', sourceEventId: userEvent.id });
  if (candidate?.status === 'matched_for_research') {
    await store.appendEvent(sessionId, { id: `identity:${userEvent.id}:candidate`, at: new Date().toISOString(), type: 'fact', key: 'public_identity_candidate', value: `${candidate.name} at ${candidate.company}`, evidence: 'tentative', provenance: 'tool_observed', sourceEventId: userEvent.id, sourceUrl: candidate.sourceUrl });
    try {
      const result = await research(candidate, key);
      if (result) {
        await store.appendEvent(sessionId, { id: `identity:${userEvent.id}:research-status`, at: new Date().toISOString(), type: 'fact', key: 'public_research_status', value: result.partial ? 'partial' : 'complete', evidence: 'tentative', provenance: 'tool_observed', sourceEventId: userEvent.id, sourceUrl: result.sources[0] });
        if (result.role) await store.appendEvent(sessionId, { id: `identity:${userEvent.id}:role`, at: new Date().toISOString(), type: 'fact', key: 'public_role', value: result.role, evidence: 'tentative', provenance: 'tool_observed', sourceEventId: userEvent.id, sourceUrl: result.sources[0] });
        if (result.companySummary) await store.appendEvent(sessionId, { id: `identity:${userEvent.id}:summary`, at: new Date().toISOString(), type: 'fact', key: 'public_company_summary', value: result.companySummary, evidence: 'tentative', provenance: 'tool_observed', sourceEventId: userEvent.id, sourceUrl: result.sources[0] });
        return { ...candidate, research: result };
      }
    } catch (error) { console.error('Matched identity research failed', error); }
  }
  return candidate || { status: 'not_found' };
}
