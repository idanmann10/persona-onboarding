import { readSessionCookie } from './session';
import { deletePersonaSession } from '../integrations/deletion';

interface Store {
  sessionExists(id: string): Promise<boolean>;
  listConnectionAccounts(id: string): Promise<string[]>;
  deleteSession(id: string): Promise<void>;
}
interface Client { deleteAccount(id: string): Promise<void> }

export function createDeleteSessionHandler(store: Store, client: Client, appBaseUrl: string) {
  return async (request: Request): Promise<Response> => {
    const id = readSessionCookie(request);
    if (!id || !(await store.sessionExists(id))) return new Response('Session required', { status: 401 });
    const origin = new URL(appBaseUrl).origin;
    if (request.headers.get('origin') !== origin) return new Response('Origin mismatch', { status: 403 });
    try { await deletePersonaSession(store, client, id); }
    catch (error) { console.error('Session deletion failed', error); return new Response('Deletion could not be completed', { status: 503 }); }
    const secure = origin.startsWith('https:') ? '; Secure' : '';
    return new Response(null, { status: 204, headers: { 'Set-Cookie': `persona_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`, 'Cache-Control': 'no-store' } });
  };
}
