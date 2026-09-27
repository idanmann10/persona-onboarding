import { describe, expect, it } from 'vitest';
import { createConnectionsService } from '../../lib/integrations/connections';

describe('account connection service', () => {
  it('binds the auth link to a stored session attempt and verifies the callback account', async () => {
    let saved: { sessionId: string; attemptId: string; accountId: string; authConfigId: string } | undefined;
    let active = false;
    const store = {
      createConnectionAttempt: async (sessionId: string, attemptId: string, _toolkit: string, accountId: string, authConfigId: string) => { saved = { sessionId, attemptId, accountId, authConfigId }; },
      getConnectionAttempt: async (sessionId: string, attemptId: string) => saved?.sessionId === sessionId && saved.attemptId === attemptId ? { toolkit: 'calendar' as const, accountId: saved.accountId, authConfigId: saved.authConfigId, status: 'pending' } : undefined,
      activateConnection: async () => { active = true; return true; },
      getActiveConnection: async () => active ? 'ca_one' : undefined,
      deactivateConnection: async () => { active = false; return true; },
    };
    const client = {
      createLink: async () => ({ accountId: 'ca_one', redirectUrl: 'https://connect.composio.dev/start', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      getAccount: async () => ({ id: 'ca_one', user_id: 'owner', status: 'ACTIVE', toolkit: { slug: 'googlecalendar' }, auth_config: { id: 'auth_calendar' } }),
      deleteAccount: async () => undefined,
    };
    const service = createConnectionsService(store, client, { calendar: 'auth_calendar' }, 'https://persona.example');
    const link = await service.start('owner', 'calendar');
    expect(link.redirectUrl).toContain('composio.dev');
    expect(saved?.attemptId).toBe(link.attemptId);
    await expect(service.finish('stranger', link.attemptId)).rejects.toThrow();
    expect(active).toBe(false);
    expect(await service.finish('owner', link.attemptId)).toBe('calendar');
    expect(active).toBe(true);
    await service.disconnect('owner', 'calendar');
    expect(active).toBe(false);
  });

  it('does not activate an account owned by a different Composio user', async () => {
    let activated = false;
    const service = createConnectionsService({
      createConnectionAttempt: async () => undefined,
      getConnectionAttempt: async () => ({ toolkit: 'gmail' as const, accountId: 'ca_other', authConfigId: 'auth_gmail', status: 'pending' }),
      activateConnection: async () => { activated = true; return true; },
      getActiveConnection: async () => undefined,
      deactivateConnection: async () => false,
    }, {
      createLink: async () => ({ accountId: 'ca_other', redirectUrl: 'https://connect.composio.dev/start' }),
      getAccount: async () => ({ id: 'ca_other', user_id: 'stranger', status: 'ACTIVE', toolkit: { slug: 'gmail' }, auth_config: { id: 'auth_gmail' } }),
      deleteAccount: async () => undefined,
    }, { gmail: 'auth_gmail' }, 'https://persona.example');
    await expect(service.finish('owner', crypto.randomUUID())).rejects.toThrow('verification');
    expect(activated).toBe(false);
  });

  it('removes a prior provider connection before activating a replacement', async () => {
    const calls: string[] = [];
    const service = createConnectionsService({
      createConnectionAttempt: async () => undefined,
      getConnectionAttempt: async () => ({ toolkit: 'calendar' as const, accountId: 'ca_new', authConfigId: 'auth_calendar', status: 'pending' }),
      getActiveConnection: async () => 'ca_old',
      deactivateConnection: async () => { calls.push('deactivate'); return true; },
      activateConnection: async () => { calls.push('activate'); return true; },
    }, {
      createLink: async () => ({ accountId: 'ca_new', redirectUrl: 'https://connect.composio.dev/start' }),
      getAccount: async () => ({ id: 'ca_new', user_id: 'owner', status: 'ACTIVE', toolkit: { slug: 'googlecalendar' }, auth_config: { id: 'auth_calendar' } }),
      deleteAccount: async (id: string) => { calls.push(`delete:${id}`); },
    }, { calendar: 'auth_calendar' }, 'https://persona.example');
    await service.finish('owner', crypto.randomUUID());
    expect(calls).toEqual(['delete:ca_old', 'deactivate', 'activate']);
  });
});
