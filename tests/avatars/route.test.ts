import { describe, expect, it } from 'vitest';
import { createAvatarHandler } from '../../lib/avatars/route';

const ID = '0f8b3c2a-5d1e-4c7b-9a2f-3e4d5c6b7a81';
const BYTES = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);

describe('GET /api/avatars/[id]', () => {
  const lookups: string[] = [];
  const handler = createAvatarHandler({
    getAvatar: async (id) => { lookups.push(id); return id === ID ? { mime: 'image/webp', bytes: BYTES } : undefined; },
  });

  it('serves the portrait with its type and a year-long immutable cache', async () => {
    const response = await handler(new Request(`http://localhost/api/avatars/${ID}`), ID.toUpperCase());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...BYTES]);
  });

  it('is a 404 for an unknown id, and never queries for an id that is not a uuid', async () => {
    lookups.length = 0;
    const unknown = await handler(new Request('http://localhost/api/avatars/x'), '11111111-2222-4333-8444-555555555555');
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('cache-control')).toBe('no-store');
    for (const bad of ['nope', `${ID}.webp`, "1' OR '1'='1", '']) expect((await handler(new Request('http://localhost/api/avatars/x'), bad)).status).toBe(404);
    expect(lookups).toEqual(['11111111-2222-4333-8444-555555555555']);
  });
});
