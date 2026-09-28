import type { SessionEvent } from '../domain/events';
import type { SessionProjection } from '../domain/project';
import { localClock, userTimeZone } from '../domain/user-state';

export const GREETING_ID = 'greeting:v3';

const GIVEN_NAME = /^[\p{L}][\p{L}' -]{0,29}$/u;

/**
 * The short first message used only when the assistant can't write its own (no model, or it failed; see
 * lib/agent/first-message.ts), and by the eval harness's fixtures. Calm, per the soul's onboarding tone:
 * hello by first name, one line on what it's for, then the one ask that belongs to the chat.
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
