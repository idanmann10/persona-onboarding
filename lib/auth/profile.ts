import type { SessionEvent } from '../domain/events';
import { projectSession } from '../domain/project';
import { isValidTimeZone } from '../domain/schedule';

/**
 * What sign-in tells the assistant about the user, written as ordinary fact events (tool_observed) so the
 * agent reads them like anything else it knows. Names are tentative, so the assistant confirms what to call
 * someone; an email Google verified is confirmed, one typed at sign-up is tentative. Location comes from
 * Vercel's IP geolocation headers and is only ever a guess.
 */
export interface FactStore {
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
}

export interface SeedFact { key: string; value: string; evidence: 'tentative' | 'confirmed' }

export interface Profile { email: string; emailVerified: boolean; fullName?: string; givenName?: string; picture?: string; locale?: string }

export function profileFacts(profile: Profile): SeedFact[] {
  const facts: SeedFact[] = [{ key: 'user_email', value: profile.email, evidence: profile.emailVerified ? 'confirmed' : 'tentative' }];
  if (profile.fullName) facts.push({ key: 'user_full_name', value: profile.fullName, evidence: 'tentative' });
  if (profile.givenName) facts.push({ key: 'user_given_name', value: profile.givenName, evidence: 'tentative' });
  if (profile.picture) facts.push({ key: 'user_picture', value: profile.picture, evidence: 'confirmed' });
  if (profile.locale) facts.push({ key: 'user_locale', value: profile.locale, evidence: 'confirmed' });
  return facts;
}

const plain = (value: string, max: number) => {
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return text && text.length <= max ? text : undefined;
};

/** Where the request comes from, per Vercel's geolocation headers. Empty off Vercel. */
export function locationFacts(request: Request): SeedFact[] {
  const header = (name: string) => request.headers.get(name)?.trim() || undefined;
  const facts: SeedFact[] = [];
  const rawCity = header('x-vercel-ip-city');
  let city: string | undefined;
  if (rawCity) { try { city = plain(decodeURIComponent(rawCity), 100); } catch { city = undefined; } }
  if (city) facts.push({ key: 'location_city', value: city, evidence: 'tentative' });
  const region = header('x-vercel-ip-country-region');
  if (region && /^[A-Za-z0-9]{1,3}$/.test(region)) facts.push({ key: 'location_region', value: region.toUpperCase(), evidence: 'tentative' });
  const country = header('x-vercel-ip-country');
  if (country && /^[A-Za-z]{2}$/.test(country)) facts.push({ key: 'location_country', value: country.toUpperCase(), evidence: 'tentative' });
  const timezone = header('x-vercel-ip-timezone');
  if (timezone && isValidTimeZone(timezone)) facts.push({ key: 'timezone', value: timezone, evidence: 'tentative' });
  return facts;
}

/**
 * Appends each fact whose value is new. Never overrides what the user said, confirmed or declined in the
 * conversation for that key. True when anything was written.
 */
export async function recordFacts(store: FactStore, sessionId: string, facts: SeedFact[], events: SessionEvent[], source: string): Promise<boolean> {
  if (!facts.length) return false;
  const state = projectSession(events);
  const at = new Date().toISOString();
  let wrote = false;
  for (const fact of facts) {
    const current = state.facts[fact.key];
    if (current && (current.provenance === 'user_said' || current.provenance === 'user_confirmed' || current.value === fact.value)) continue;
    if (!current && state.history.some((earlier) => earlier.key === fact.key && earlier.evidence === 'declined')) continue;
    await store.appendEvent(sessionId, {
      id: `${source}:${fact.key}:${crypto.randomUUID()}`, at, type: 'fact', key: fact.key, value: fact.value,
      evidence: fact.evidence, provenance: 'tool_observed', sourceEventId: source,
    });
    wrote = true;
  }
  return wrote;
}
