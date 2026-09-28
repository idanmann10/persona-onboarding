import type { SessionEvent } from '../domain/events';
import { projectSession, type SessionProjection } from '../domain/project';
import { localClock, userTimeZone } from '../domain/user-state';

interface Store {
  appendEvent(id: string, event: SessionEvent): Promise<void>;
}

export const GREETING_ID = 'greeting:v3';

const GIVEN_NAME = /^[\p{L}][\p{L}' -]{0,29}$/u;

/**
 * The first message, from state and not a model call, so it's instant. Calm, per the soul's onboarding
 * tone: hello by first name when Google gave us one, one line on what it's for, then the one ask that
 * belongs to the chat, a name for the assistant, with an easy way to skip straight to their task.
 */
export function greetingText(state: SessionProjection, now = new Date()): string {
  const given = state.facts.user_given_name?.value?.trim();
  const name = given && GIVEN_NAME.test(given) ? given : undefined;
  const zone = userTimeZone(state);
  const hour = zone ? localClock(now, zone).hour : undefined;
  const opener = hour !== undefined && hour >= 5 && hour < 12 ? 'Morning' : hour !== undefined && hour >= 18 && hour < 23 ? 'Evening' : 'Hey';
  return [
    `${opener}${name ? ` ${name}` : ''}, nice to meet you.`,
    "I'm your new assistant. Email, calendar, the stuff that keeps slipping through the cracks.",
    "First thing, though: I don't have a name yet. What do you want to call me? Or skip that and tell me what's on your plate.",
  ].join('\n\n');
}

export function greetingEvent(state: SessionProjection, at = new Date()): SessionEvent {
  return { id: GREETING_ID, at: at.toISOString(), type: 'message', speaker: 'assistant', channel: 'text', text: greetingText(state, at), origin: 'greeting' };
}

/** Writes the greeting into a conversation that has no messages yet (sign-in records its facts first). */
export async function ensureGreeting(store: Store, id: string, events: SessionEvent[]): Promise<SessionEvent[]> {
  if (events.some((event) => event.type === 'message')) return events;
  const greeting = greetingEvent(projectSession(events));
  await store.appendEvent(id, greeting);
  return [...events, greeting];
}
