export interface AvatarReader {
  getAvatar(id: string): Promise<{ mime: string; bytes: Uint8Array } | undefined>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

/** Serves a painted portrait by id. A portrait never changes once painted, so it is cached for a year. */
export function createAvatarHandler(store: AvatarReader) {
  return async (_request: Request, id: string): Promise<Response> => {
    if (!UUID.test(id)) return notFound();
    const avatar = await store.getAvatar(id.toLowerCase());
    if (!avatar) return notFound();
    return new Response(new Uint8Array(avatar.bytes), {
      headers: {
        'Content-Type': avatar.mime,
        'Content-Length': String(avatar.bytes.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  };
}
