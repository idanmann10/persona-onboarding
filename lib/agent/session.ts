import type { SessionEvent } from '../domain/events';

interface Store {
  createSession(id: string): Promise<void>;
  sessionExists(id: string): Promise<boolean>;
  readEvents(id: string): Promise<SessionEvent[]>;
}

export async function getGuestSession(store: Store, cookie?: string): Promise<{ id: string; created: boolean; events: SessionEvent[] }> {
  const isUuid = cookie && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cookie);
  if (isUuid && await store.sessionExists(cookie)) {
    return { id: cookie, created: false, events: await store.readEvents(cookie) };
  }
  const id = crypto.randomUUID();
  await store.createSession(id);
  return { id, created: true, events: [] };
}
