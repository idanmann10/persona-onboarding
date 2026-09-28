import { signedInSession, type LoginStore } from '../auth/login';

export interface AvatarReader extends LoginStore {
  getAvatar(id: string, sessionId: string): Promise<{ mime: string; bytes: Uint8Array } | undefined>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

/**
 * Serves a painted portrait by id, only to the signed-in user whose conversation it was painted for. A
 * portrait never changes once painted, so the browser keeps it for a year; shared caches never do.
 */
export function createAvatarHandler(store: AvatarReader) {
  return async (request: Request, id: string): Promise<Response> => {
    const sessionId = await signedInSession(store, request);
    if (!sessionId) return new Response('Sign-in required', { status: 401, headers: { 'Cache-Control': 'no-store' } });
    if (!UUID.test(id)) return notFound();
    const avatar = await store.getAvatar(id.toLowerCase(), sessionId);
    if (!avatar) return notFound();
    return new Response(new Uint8Array(avatar.bytes), {
      headers: {
        'Content-Type': avatar.mime,
        'Content-Length': String(avatar.bytes.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  };
}
