import type { SessionEvent } from '../domain/events';
import { projectSession, type SessionProjection } from '../domain/project';
import { distinctiveHandle, lookupByHandle, lookupPersonCandidate } from '../research/people';
import { prepareTurn } from './turn';
import { generateTurn, streamTurn, undash } from './runtime';
import { greetingText } from './session';
import type { FollowUpDeps } from './follow-ups';

/**
 * The first message of a conversation, written by the assistant from what sign-in told it (name, email,
 * where and when they are, and a confident public match for a work email), not a template. Written once:
 * a reservation keeps a second tab or a reload from writing another, and the message's fixed id makes the
 * write idempotent. Without a model it falls back to a short template.
 */
export const FIRST_MESSAGE_ID = 'greeting:v4';
/** The reservation the page's typing dots watch (see /api/agent/updates). */
const RESERVATION = 'reach:first-message';

const FREE_MAIL = /(^|\.)(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|yandex|zoho|fastmail|hey|duck|tutanota|qq|163|126|naver|web|orange|comcast|verizon|att|sbcglobal)\.[a-z.]+$|\.test$|\.example$|\.invalid$|\.local$/i;
const SECOND_LEVEL = /^(co|com|org|net|ac|gov|edu)$/;

/** The company a work email points at ("dana@studio-kite.com" is Studio Kite); none for personal mail. */
export function workEmailCompany(email?: string): string | undefined {
  const domain = email?.split('@')[1]?.toLowerCase();
  if (!domain || FREE_MAIL.test(domain)) return undefined;
  const labels = domain.split('.');
  if (labels.length < 2) return undefined;
  const name = labels.length >= 3 && SECOND_LEVEL.test(labels.at(-2)!) ? labels.at(-3)! : labels.at(-2)!;
  if (!/^[a-z0-9-]{2,40}$/.test(name)) return undefined;
  return name.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

/**
 * The identity check for sign-in, once, from a Google-verified email only (a typed one could be anyone's).
 * A work email: the verified name plus the domain's company, looked up with Exa; only a single confident
 * match counts (the same gate as a stated identity, lib/research). A personal email: its handle
 * ("idanmann10") plus the name, keeping only pages that carry both. Found profiles are tentative facts.
 */
async function signInIdentity(deps: FollowUpDeps, sessionId: string, state: SessionProjection): Promise<void> {
  const key = deps.env.EXA_API_KEY;
  if (!key || state.facts.identity_lookup_status || state.history.some((fact) => fact.key === 'identity_lookup_status')) return;
  const email = state.facts.user_email;
  const fullName = state.facts.user_full_name?.value?.trim() ?? '';
  const full = fullName.split(/\s+/);
  if (email?.evidence !== 'confirmed' || full.length < 2) return;
  const company = workEmailCompany(email.value);
  const handle = company ? undefined : distinctiveHandle(email.value, full[0]);
  if (!company && !handle) return;
  const at = () => (deps.now?.() ?? new Date()).toISOString();
  const fact = (name: string, value: string, sourceUrl?: string): SessionEvent => ({ id: `signin:identity:${name}`, at: at(), type: 'fact', key: name, value, evidence: 'tentative', provenance: 'tool_observed', sourceEventId: 'signin:identity', ...(sourceUrl ? { sourceUrl } : {}) });
  // A slow lookup never holds up the hello for long.
  const timeout = <T>(work: Promise<T>) => Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), 6_000))]);
  try {
    if (company) {
      const candidate = await timeout(lookupPersonCandidate({ first: full[0], last: full.slice(1).join(' '), company, provenance: 'tool_observed' }, key));
      await deps.store.appendEvent(sessionId, fact('identity_lookup_status', candidate?.status ?? 'not_found'));
      if (candidate?.status === 'matched_for_research') {
        await deps.store.appendEvent(sessionId, fact('public_identity_candidate', `${candidate.name} at ${candidate.company}`, candidate.sourceUrl));
        if (candidate.headline) await deps.store.appendEvent(sessionId, fact('public_headline', candidate.headline, candidate.sourceUrl));
      }
      return;
    }
    const found = await timeout(lookupByHandle(fullName, handle!, key));
    await deps.store.appendEvent(sessionId, fact('identity_lookup_status', found ? 'matched_for_research' : 'not_found'));
    if (found) {
      await deps.store.appendEvent(sessionId, fact('public_identity_candidate', `${found.name} (${found.handle} online)`, found.profiles[0].url));
      const profile = found.profiles.map((item) => `${item.title}: ${item.snippet} (${item.url})`).join(' | ').slice(0, 700);
      await deps.store.appendEvent(sessionId, fact('public_profile', profile, found.profiles[0].url));
    }
  } catch (error) {
    console.error('Sign-in identity lookup failed', error instanceof Error ? error.message : error);
  }
}

const NOTE = `App note, not from the user: they just signed in, and this is the very first message of your conversation. Write it now, like a person texting someone they just met, not like a product.
- Open with "hey" and their first name if you have it.
- If "Other facts" has a public match (public_identity_candidate, with public_headline or public_profile), make it personal: say what they do in plain words, lightly, as something you noticed, and offer one concrete thing you could take off their plate because of it. For example: "hey Dana, looks like you're running Acme. I could take investor updates or inbox triage off your hands if you want." Keep it to their work, never their private life, and never pretend to be sure.
- Without a match, skip the pitch: a short, warm hello and one real question about what's eating their time.
- Somewhere in there, casually, ask what they want to call you ("oh and what do you want to call me?").
- Don't describe yourself or list what you do. No slogans, no cute bits, no wordplay. If a line would make a friend cringe, cut it.
- One or two short bubbles. Casual, not formal. No emoji, no exclamation marks.`;

async function prepare(deps: FollowUpDeps, sessionId: string) {
  await signInIdentity(deps, sessionId, projectSession(await deps.store.readEvents(sessionId)));
  const turn = await prepareTurn(deps, sessionId, await deps.store.readEvents(sessionId), { turnId: 'first-message', trigger: { id: 'first-message', instruction: NOTE } });
  // Nothing to do yet but say hello: no tools.
  return { ...turn, tools: {} };
}

const hasMessage = (events: SessionEvent[]) => events.some((event) => event.type === 'message');

async function save(deps: FollowUpDeps, sessionId: string, text: string, state: SessionProjection) {
  const body = text.trim() || greetingText(state, deps.now?.());
  await deps.store.appendEvent(sessionId, { id: FIRST_MESSAGE_ID, at: (deps.now?.() ?? new Date()).toISOString(), type: 'message', speaker: 'assistant', channel: 'text', text: body, origin: 'greeting' });
}

/**
 * Streams the first message into a conversation that has none. 'exists' when it was already written,
 * 'pending' while another request writes it. A model failure saves the short template instead.
 */
export async function openConversation(deps: FollowUpDeps, sessionId: string): Promise<'exists' | 'pending' | AsyncGenerator<string>> {
  if (hasMessage(await deps.store.readEvents(sessionId))) return 'exists';
  if (!(await deps.store.reserve(sessionId, RESERVATION))) return 'pending';
  const configured = Boolean(deps.env.OPENAI_API_KEY && deps.env.OPENAI_TEXT_MODEL);
  return (async function* () {
    let text = '';
    let state = projectSession(await deps.store.readEvents(sessionId));
    try {
      try {
        if (configured) {
          const turn = await prepare(deps, sessionId);
          state = turn.state;
          for await (const chunk of streamTurn(turn, deps.env, deps.model)) { text += chunk; yield chunk; }
        }
      } catch (error) { console.error('First message failed; using the short greeting', error); }
      if (!text.trim()) { text = greetingText(state, deps.now?.()); yield text; }
    } finally {
      // Saved even if the page went away mid-stream, so a reload shows it rather than writing another.
      await save(deps, sessionId, text, state);
      await deps.store.releaseReservation(sessionId, RESERVATION);
    }
  })();
}

/** The same, all at once (the eval harness). */
export async function writeFirstMessage(deps: FollowUpDeps, sessionId: string): Promise<string | undefined> {
  if (hasMessage(await deps.store.readEvents(sessionId))) return undefined;
  let text = '';
  try { text = undash(await generateTurn(await prepare(deps, sessionId), deps.env, deps.model)); }
  catch (error) { console.error('First message failed; using the short greeting', error); }
  const state = projectSession(await deps.store.readEvents(sessionId));
  await save(deps, sessionId, text, state);
  return text || greetingText(state, deps.now?.());
}
