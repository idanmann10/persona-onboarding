import { signedInSession, type LoginStore } from '../auth/login';

interface Store extends LoginStore {
  latestEventSeq(id: string): Promise<number>;
  hasActiveReservation(id: string, prefix: string, seconds: number): Promise<boolean>;
}

/** A follow-up in progress shows as typing for at most this long. */
const WRITING_SECONDS = 90;
/** Settling what's owed runs at most this often per session per server instance. */
const WAKE_EVERY_MS = 20_000;
const lastWake = new Map<string, number>();

/**
 * GET /api/agent/updates[?wake=1]: how the open page learns about follow-ups. It answers with the
 * latest event number (the page reloads the conversation when it moves) and whether a follow-up is
 * being written. `wake=1`, sent on load and when the page comes back into view, lets the server settle
 * anything owed: a check-in that came due, a return after a gap, a trigger whose background run died.
 */
export function createUpdatesHandler(store: Store, wake: (sessionId: string) => void) {
  return async (request: Request): Promise<Response> => {
    const sessionId = await signedInSession(store, request);
    if (!sessionId) return new Response('Session required', { status: 401 });
    if (new URL(request.url).searchParams.get('wake') === '1' && Date.now() - (lastWake.get(sessionId) ?? 0) > WAKE_EVERY_MS) {
      lastWake.set(sessionId, Date.now());
      if (lastWake.size > 5_000) lastWake.clear();
      wake(sessionId);
    }
    const [seq, writing] = await Promise.all([store.latestEventSeq(sessionId), store.hasActiveReservation(sessionId, 'reach:', WRITING_SECONDS)]);
    return Response.json({ seq, writing }, { headers: { 'Cache-Control': 'no-store' } });
  };
}
