import { describe, expect, it } from 'vitest';
import { createComposioClient } from '../../lib/integrations/composio';

describe('Composio client', () => {
  it('starts a scoped link for the session and validates the redirect', async () => {
    let sent: Record<string, unknown> | undefined;
    const fetchFn = async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://backend.composio.dev/api/v3.1/connected_accounts/link');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('secret');
      sent = JSON.parse(String(init?.body));
      return Response.json({ connected_account_id: 'ca_one', redirect_url: 'https://connect.composio.dev/start', expires_at: '2026-09-28T00:00:00Z' }, { status: 201 });
    };
    const client = createComposioClient('secret', fetchFn as typeof fetch);
    expect(await client.createLink('session-one', 'auth-calendar', 'https://persona.example/api/connections/callback?attempt=a')).toMatchObject({ accountId: 'ca_one', redirectUrl: 'https://connect.composio.dev/start' });
    expect(sent).toMatchObject({ user_id: 'session-one', auth_config_id: 'auth-calendar', callback_url: 'https://persona.example/api/connections/callback?attempt=a' });
  });

  it('rejects an unsafe redirect and failed tool execution', async () => {
    const unsafe = createComposioClient('secret', async () => Response.json({ connected_account_id: 'ca_one', redirect_url: 'javascript:alert(1)' }, { status: 201 }));
    await expect(unsafe.createLink('user', 'auth', 'https://persona.example/callback')).rejects.toThrow('redirect');
    const failed = createComposioClient('secret', async () => Response.json({ successful: false, error: 'scope missing' }));
    await expect(failed.executeRead('GOOGLECALENDAR_EVENTS_LIST', 'ca_one', 'user', { calendarId: 'primary' })).rejects.toThrow('scope missing');
  });

  it('executes a bounded read with the exact connected account', async () => {
    let sent: Record<string, unknown> | undefined;
    const client = createComposioClient('secret', async (url, init) => {
      expect(String(url)).toContain('/tools/execute/GOOGLECALENDAR_EVENTS_LIST');
      sent = JSON.parse(String(init?.body));
      return Response.json({ successful: true, data: { items: [{ summary: 'Meeting' }] } });
    });
    expect(await client.executeRead('GOOGLECALENDAR_EVENTS_LIST', 'ca_one', 'user-one', { calendarId: 'primary', maxResults: 10 })).toEqual({ items: [{ summary: 'Meeting' }] });
    expect(sent).toEqual({ connected_account_id: 'ca_one', user_id: 'user-one', version: 'latest', arguments: { calendarId: 'primary', maxResults: 10 } });
  });

  it('deletes a connection and requests upstream token revocation', async () => {
    const client = createComposioClient('secret', async (url, init) => {
      expect(String(url)).toBe('https://backend.composio.dev/api/v3.1/connected_accounts/ca_one?revoke_on_delete=true');
      expect(init?.method).toBe('DELETE');
      return Response.json({ success: true });
    });
    await expect(client.deleteAccount('ca_one')).resolves.toBeUndefined();
    const alreadyDeleted = createComposioClient('secret', async () => new Response(null, { status: 404 }));
    await expect(alreadyDeleted.deleteAccount('ca_one')).resolves.toBeUndefined();
  });
});
