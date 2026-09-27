export type Toolkit = 'calendar' | 'gmail';

interface Store {
  createConnectionAttempt(sessionId: string, attemptId: string, toolkit: Toolkit, accountId: string, authConfigId: string, expiresAt: string): Promise<void>;
  getConnectionAttempt(sessionId: string, attemptId: string): Promise<{ toolkit: Toolkit; accountId: string; authConfigId: string; status: string } | undefined>;
  activateConnection(sessionId: string, attemptId: string): Promise<boolean>;
  getActiveConnection(sessionId: string, toolkit: Toolkit): Promise<string | undefined>;
  deactivateConnection(sessionId: string, toolkit: Toolkit, accountId: string): Promise<boolean>;
}

interface Client {
  createLink(userId: string, authConfigId: string, callbackUrl: string): Promise<{ accountId: string; redirectUrl: string; expiresAt?: string }>;
  getAccount(accountId: string): Promise<Record<string, unknown>>;
  deleteAccount(accountId: string): Promise<void>;
}

export function createConnectionsService(store: Store, client: Client, authConfigs: Partial<Record<Toolkit, string>>, appBaseUrl: string) {
  return {
    start: async (sessionId: string, toolkit: Toolkit) => {
      const authConfigId = authConfigs[toolkit];
      if (!authConfigId) throw new Error(`${toolkit} connection is unavailable`);
      const attemptId = crypto.randomUUID();
      const callbackUrl = new URL('/api/connections/callback', appBaseUrl);
      callbackUrl.searchParams.set('attempt', attemptId);
      const link = await client.createLink(sessionId, authConfigId, callbackUrl.toString());
      await store.createConnectionAttempt(sessionId, attemptId, toolkit, link.accountId, authConfigId, link.expiresAt || new Date(Date.now() + 10 * 60_000).toISOString());
      return { attemptId, redirectUrl: link.redirectUrl };
    },
    finish: async (sessionId: string, attemptId: string): Promise<Toolkit> => {
      const attempt = await store.getConnectionAttempt(sessionId, attemptId);
      if (!attempt || attempt.status !== 'pending') throw new Error('Connection attempt not found');
      const account = await client.getAccount(attempt.accountId);
      const toolkit = account.toolkit as { slug?: string } | undefined;
      const authConfig = account.auth_config as { id?: string } | undefined;
      if (account.id !== attempt.accountId || account.user_id !== sessionId || account.status !== 'ACTIVE' ||
          toolkit?.slug !== (attempt.toolkit === 'calendar' ? 'googlecalendar' : 'gmail') || authConfig?.id !== attempt.authConfigId) {
        throw new Error('Connected account verification failed');
      }
      const priorAccountId = await store.getActiveConnection(sessionId, attempt.toolkit);
      if (priorAccountId && priorAccountId !== attempt.accountId) {
        await client.deleteAccount(priorAccountId);
        await store.deactivateConnection(sessionId, attempt.toolkit, priorAccountId);
      }
      if (!(await store.activateConnection(sessionId, attemptId))) throw new Error('Connection attempt expired');
      return attempt.toolkit;
    },
    disconnect: async (sessionId: string, toolkit: Toolkit): Promise<void> => {
      const accountId = await store.getActiveConnection(sessionId, toolkit);
      if (!accountId) return;
      await client.deleteAccount(accountId);
      if (!(await store.deactivateConnection(sessionId, toolkit, accountId))) throw new Error('Connection state changed during deletion');
    },
  };
}
