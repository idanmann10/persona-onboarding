import type { SessionEvent, Toolkit } from '../../lib/domain/events';
import type { AutomationRecord } from '../../lib/domain/automation';
import type { TraceEntry } from '../../lib/observability/trace';
import { hashLoginToken, type SignedInUser } from '../../lib/auth/login';

/** The harness's signed-in browser: send it as the persona_auth cookie to call the app's endpoints. */
export const EVAL_LOGIN_TOKEN = 'eval-harness-login-token-000000000000000000';

/**
 * An in-memory stand-in for the Postgres store with the same idempotent append semantics. One signed-in
 * user (EVAL_LOGIN_TOKEN) owns its one conversation, `sessionId`.
 */
export function createMemoryStore(connected: Partial<Record<Toolkit, string>> = {}, sessionId = 'eval-session') {
  const user: SignedInUser = { accountId: 'eval-user', sessionId, email: 'eval@persona.test' };
  const events: SessionEvent[] = [];
  const ids = new Set<string>();
  const reservations = new Set<string>();
  const automations: AutomationRecord[] = [];
  const traces: TraceEntry[] = [];
  return {
    events,
    connected,
    automations,
    traces,
    appendTrace: async (_sessionId: string, entry: TraceEntry) => { traces.push(entry); },
    proposeAutomation: async (sessionId: string, automation: Omit<AutomationRecord, 'sessionId' | 'status' | 'timezone' | 'nextRunAt'>) => {
      automations.push({ ...automation, sessionId, status: 'proposed' });
    },
    sessionExists: async () => true,
    findLogin: async (tokenHash: string) => (tokenHash === hashLoginToken(EVAL_LOGIN_TOKEN) ? user : undefined),
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
