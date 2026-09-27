import { describe, expect, it } from 'vitest';
import { createDeleteSessionHandler } from '../../lib/http/delete-session';

describe('session deletion HTTP contract', () => {
  it('requires same-origin ownership and clears the cookie only after provider and local deletion', async () => {
    const order: string[] = [];
    const handler = createDeleteSessionHandler({
      sessionExists: async (id: string) => id === 'owner',
      listConnectionAccounts: async () => ['ca_one'],
      deleteSession: async () => { order.push('local'); },
    }, { deleteAccount: async () => { order.push('provider'); } }, 'https://persona.example');
    const request = (cookie: string, origin: string) => new Request('https://persona.example/api/session', { method: 'DELETE', headers: { cookie: `persona_session=${cookie}`, origin } });
    expect((await handler(request('stranger', 'https://persona.example'))).status).toBe(401);
    expect((await handler(request('owner', 'https://evil.example'))).status).toBe(403);
    expect(order).toEqual([]);
    const response = await handler(request('owner', 'https://persona.example'));
    expect(response.status).toBe(204);
    expect(order).toEqual(['provider', 'local']);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
