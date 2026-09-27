import { describe, expect, it } from 'vitest';
import { createConnectionHandlers } from '../../lib/http/connections';

describe('connection HTTP contracts', () => {
  const store = { sessionExists: async (id: string) => id === 'owner', getActiveConnection: async (_id: string, toolkit: string) => toolkit === 'calendar' ? 'ca_one' : undefined };
  const attemptId = '123e4567-e89b-42d3-a456-426614174000';
  let disconnected = false;
  const service = { start: async () => ({ attemptId, redirectUrl: 'https://connect.composio.dev/start' }), finish: async () => 'calendar' as const, disconnect: async () => { disconnected = true; } };
  const handlers = createConnectionHandlers(store, service, 'https://persona.example');

  it('requires an owned cookie and same-origin POST for an optional connection', async () => {
    const request = (cookie?: string, origin = 'https://persona.example') => new Request('https://persona.example/api/connections', { method: 'POST', headers: { origin, ...(cookie ? { cookie: `persona_session=${cookie}` } : {}) }, body: JSON.stringify({ toolkit: 'calendar' }) });
    expect((await handlers.start(request())).status).toBe(401);
    expect((await handlers.start(request('owner', 'https://evil.example'))).status).toBe(403);
    expect((await handlers.start(request('owner'))).status).toBe(200);
    expect((await handlers.start(new Request('https://persona.example/api/connections', { method: 'POST', headers: { origin: 'https://persona.example', cookie: 'persona_session=owner' }, body: JSON.stringify({ toolkit: 'other' }) }))).status).toBe(400);
  });

  it('only reports the current session connections and ignores callback parameters other than attempt', async () => {
    const status = await handlers.status(new Request('https://persona.example/api/connections', { headers: { cookie: 'persona_session=owner' } }));
    expect(await status.json()).toEqual({ calendar: true, gmail: false });
    const callback = await handlers.callback(new Request(`https://persona.example/api/connections/callback?attempt=${attemptId}&connected_account_id=ca_stranger`, { headers: { cookie: 'persona_session=owner' } }));
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('https://persona.example/?connection=calendar');
  });

  it('requires the owning session and same origin to disconnect', async () => {
    const request = (cookie: string, origin: string) => new Request('https://persona.example/api/connections', { method: 'DELETE', headers: { cookie: `persona_session=${cookie}`, origin }, body: JSON.stringify({ toolkit: 'calendar' }) });
    disconnected = false;
    expect((await handlers.disconnect(request('stranger', 'https://persona.example'))).status).toBe(401);
    expect((await handlers.disconnect(request('owner', 'https://evil.example'))).status).toBe(403);
    expect(disconnected).toBe(false);
    expect((await handlers.disconnect(request('owner', 'https://persona.example'))).status).toBe(204);
    expect(disconnected).toBe(true);
  });
});
