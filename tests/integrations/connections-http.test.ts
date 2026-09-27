import { describe, expect, it } from 'vitest';
import { createConnectionHandlers } from '../../lib/http/connections';

describe('connection HTTP contracts', () => {
  const events: Array<{ id: string; type: string; phase?: string; toolkit?: string }> = [];
  const store = {
    sessionExists: async (id: string) => id === 'owner',
    getActiveConnection: async (_id: string, toolkit: string) => toolkit === 'calendar' ? 'ca_one' : undefined,
    getConnectionAttempt: async (_id: string, attempt: string) => ({ toolkit: 'calendar' as const, status: attempt === doneAttempt ? 'active' : 'pending' }),
    appendEvent: async (_id: string, event: { id: string; type: string; phase?: string; toolkit?: string }) => { events.push(event); },
  };
  const attemptId = '123e4567-e89b-42d3-a456-426614174000';
  const doneAttempt = '123e4567-e89b-42d3-a456-426614174999';
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
    expect(callback.status).toBe(200);
    const page = await callback.text();
    expect(page).toContain('"status":"connected"');
    expect(page).toContain('https://persona.example/?connection=calendar');
    expect(page).toContain('postMessage(message, "https://persona.example")');
    expect(events.at(-1)).toMatchObject({ type: 'connection', toolkit: 'calendar', phase: 'connected' });
  });

  it('records a failed callback so the assistant can react, and never binds the account', async () => {
    const failing = createConnectionHandlers(store, { ...service, finish: async () => { throw new Error('not active'); } }, 'https://persona.example');
    const callback = await failing.callback(new Request(`https://persona.example/api/connections/callback?attempt=${attemptId}`, { headers: { cookie: 'persona_session=owner' } }));
    expect(await callback.text()).toContain('"status":"failed"');
    expect(events.at(-1)).toMatchObject({ type: 'connection', toolkit: 'calendar', phase: 'failed' });
  });

  it('records "Not now" on a connect card only for the owning session', async () => {
    const request = (cookie: string, origin: string, toolkit = 'gmail') => new Request('https://persona.example/api/connections/decline', { method: 'POST', headers: { cookie: `persona_session=${cookie}`, origin }, body: JSON.stringify({ toolkit }) });
    const before = events.length;
    expect((await handlers.decline(request('stranger', 'https://persona.example'))).status).toBe(401);
    expect((await handlers.decline(request('owner', 'https://evil.example'))).status).toBe(403);
    expect((await handlers.decline(request('owner', 'https://persona.example', 'other'))).status).toBe(400);
    expect((await handlers.decline(request('owner', 'https://persona.example'))).status).toBe(204);
    expect(events.slice(before)).toEqual([expect.objectContaining({ type: 'connection', toolkit: 'gmail', phase: 'declined' })]);
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

  it('treats a second visit to a successful callback as connected, not failed', async () => {
    const before = events.length;
    const failing = createConnectionHandlers(store, { ...service, finish: async () => { throw new Error('not pending'); } }, 'https://persona.example');
    const page = await failing.callback(new Request(`https://persona.example/api/connections/callback?attempt=${doneAttempt}`, { headers: { cookie: 'persona_session=owner' } }));
    expect(await page.text()).toContain('"status":"connected"');
    expect(events.length).toBe(before);
  });
});
