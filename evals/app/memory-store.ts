import type { SessionEvent, Toolkit } from '../../lib/domain/events';

/** An in-memory stand-in for the Postgres store with the same idempotent append semantics. */
export function createMemoryStore(connected: Partial<Record<Toolkit, string>> = {}) {
  const events: SessionEvent[] = [];
  const ids = new Set<string>();
  const reservations = new Set<string>();
  return {
    events,
    connected,
    sessionExists: async () => true,
    appendEvent: async (_sessionId: string, event: SessionEvent) => {
      if (ids.has(event.id)) return;
      ids.add(event.id);
      events.push(event);
    },
    readEvents: async () => [...events],
    hasEvent: async (_sessionId: string, eventId: string) => ids.has(eventId),
    getActiveConnection: async (_sessionId: string, toolkit: Toolkit) => connected[toolkit],
    reserve: async (_sessionId: string, key: string) => {
      if (reservations.has(key)) return false;
      reservations.add(key);
      return true;
    },
    releaseReservation: async (_sessionId: string, key: string) => { reservations.delete(key); },
    consumeQuota: async () => true,
    reserveIdentityClaim: async () => true,
  };
}
