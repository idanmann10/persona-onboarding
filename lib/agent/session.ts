import type { SessionEvent } from '../domain/events';

interface Store {
  createSession(id: string): Promise<void>;
  sessionExists(id: string): Promise<boolean>;
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
}

export const GREETING_ID = 'greeting:v2';
export const GREETING_TEXT = "Hi! I'm your new Persona assistant 👋 I'm here to take stuff off your plate: email, calendar, even phone calls.\n\nFirst up: what should I go by? Or skip that and tell me what's on your mind.";

export function greetingEvent(at = new Date()): SessionEvent {
  return { id: GREETING_ID, at: at.toISOString(), type: 'message', speaker: 'assistant', channel: 'text', text: GREETING_TEXT, origin: 'greeting' };
}

export async function getGuestSession(store: Store, cookie?: string): Promise<{ id: string; created: boolean; events: SessionEvent[] }> {
  const isUuid = cookie && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cookie);
  if (isUuid && await store.sessionExists(cookie)) {
    return { id: cookie, created: false, events: await store.readEvents(cookie) };
  }
  const id = crypto.randomUUID();
  await store.createSession(id);
  const greeting = greetingEvent();
  await store.appendEvent(id, greeting);
  return { id, created: true, events: [greeting] };
}
