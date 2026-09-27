import type { SessionEvent } from '../domain/events';
import { isDirectIdentityClaim } from './claim';
import { lookupPersonCandidate, type PersonCandidate } from './context';

interface Store {
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
}

type Clue = { first: string; last: string; company: string };
type Lookup = typeof lookupPersonCandidate;

export async function resolveIdentityClaim(
  store: Store,
  sessionId: string,
  userEvent: SessionEvent,
  clue: Clue,
  key: string,
  lookup: Lookup = lookupPersonCandidate,
): Promise<PersonCandidate | { status: 'insufficient_evidence' | 'already_checked' | 'not_found' }> {
  if (userEvent.type !== 'message' || userEvent.speaker !== 'user' || !isDirectIdentityClaim(userEvent.text, clue)) {
    return { status: 'insufficient_evidence' };
  }
  const checkedId = `identity:${userEvent.id}:lookup`;
  if ((await store.readEvents(sessionId)).some((event) => event.id === checkedId)) return { status: 'already_checked' };
  const at = new Date().toISOString();
  await store.appendEvent(sessionId, { id: `identity:${userEvent.id}:name`, at, type: 'fact', key: 'name', value: `${clue.first} ${clue.last}`, evidence: 'confirmed', provenance: 'user_said', sourceEventId: userEvent.id });
  await store.appendEvent(sessionId, { id: `identity:${userEvent.id}:company`, at, type: 'fact', key: 'company', value: clue.company, evidence: 'confirmed', provenance: 'user_said', sourceEventId: userEvent.id });
  const candidate = await lookup({ ...clue, provenance: 'user_said' }, key);
  await store.appendEvent(sessionId, { id: checkedId, at: new Date().toISOString(), type: 'fact', key: 'identity_lookup_status', value: candidate?.status || 'not_found', evidence: 'tentative', provenance: 'tool_observed', sourceEventId: userEvent.id });
  if (candidate?.status === 'matched_for_research') {
    await store.appendEvent(sessionId, { id: `identity:${userEvent.id}:candidate`, at: new Date().toISOString(), type: 'fact', key: 'public_identity_candidate', value: `${candidate.name} at ${candidate.company}`, evidence: 'tentative', provenance: 'tool_observed', sourceEventId: userEvent.id, sourceUrl: candidate.sourceUrl });
  }
  return candidate || { status: 'not_found' };
}
