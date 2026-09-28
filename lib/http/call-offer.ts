import type { SessionEvent } from '../domain/events';
import { projectSession } from '../domain/project';
import { signedInSession, type LoginStore } from '../auth/login';

interface Store extends LoginStore {
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
}

/** "Not now" on the in-chat call offer. Answering needs no endpoint: starting the call accepts it. */
export function createCallOfferHandler(store: Store) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Unexpected origin', { status: 403 });
    const sessionId = await signedInSession(store, request);
    if (!sessionId) return new Response('Session required', { status: 401 });
    const state = projectSession(await store.readEvents(sessionId));
    const offer = [...state.timeline].reverse().find((item) => item.kind === 'call_offer');
    if (!offer || offer.kind !== 'call_offer' || offer.status !== 'pending') return new Response(null, { status: 204 });
    await store.appendEvent(sessionId, { id: `${offer.id}:declined`, at: new Date().toISOString(), type: 'call', phase: 'declined' });
    return new Response(null, { status: 204 });
  };
}
