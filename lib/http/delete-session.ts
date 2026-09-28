import { signedInSession, type LoginStore } from '../auth/login';
import { deletePersonaSession } from '../integrations/deletion';

interface Store extends LoginStore {
  listConnectionAccounts(id: string): Promise<string[]>;
  deleteSession(id: string): Promise<void>;
}
interface Client { deleteAccount(id: string): Promise<void> }

/**
 * "Start over": revokes the conversation's connected accounts and deletes it. The user stays signed in;
 * their next page load opens a fresh main conversation.
 */
export function createDeleteSessionHandler(store: Store, client: Client, appBaseUrl: string) {
  return async (request: Request): Promise<Response> => {
    const id = await signedInSession(store, request);
    if (!id) return new Response('Session required', { status: 401 });
    const origin = new URL(appBaseUrl).origin;
    if (request.headers.get('origin') !== origin) return new Response('Origin mismatch', { status: 403 });
    try { await deletePersonaSession(store, client, id); }
    catch (error) { console.error('Session deletion failed', error); return new Response('Deletion could not be completed', { status: 503 }); }
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  };
}
