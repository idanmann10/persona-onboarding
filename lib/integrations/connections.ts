import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { composioToolkitSlug, isBuiltinApp } from '../domain/apps';

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

/** True when the callback carried the attempt's key. Only the browser Composio redirects after consent has it. */
function keyMatches(storedHash: string | undefined, key: string | null | undefined): boolean {
  if (!storedHash) return true;
  if (!key) return false;
  const given = Buffer.from(hashKey(key));
  const stored = Buffer.from(storedHash);
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/** The apps the agent can read. Any other Composio toolkit is connected under its own slug. */
export type Toolkit = 'calendar' | 'gmail';

interface Store {
  createConnectionAttempt(sessionId: string, attemptId: string, toolkit: string, accountId: string, authConfigId: string, expiresAt: string, callbackHash?: string): Promise<void>;
  getConnectionAttempt(sessionId: string, attemptId: string): Promise<{ toolkit: string; accountId: string; authConfigId: string; status: string; callbackHash?: string } | undefined>;
  activateConnection(sessionId: string, attemptId: string): Promise<boolean>;
  getActiveConnection(sessionId: string, toolkit: string): Promise<string | undefined>;
  deactivateConnection(sessionId: string, toolkit: string, accountId: string): Promise<boolean>;
}

interface Client {
  createLink(userId: string, authConfigId: string, callbackUrl: string): Promise<{ accountId: string; redirectUrl: string; expiresAt?: string }>;
  getAccount(accountId: string): Promise<Record<string, unknown>>;
  deleteAccount(accountId: string): Promise<void>;
}

/** Auth configs for apps other than Gmail and Calendar (Composio-managed OAuth, created on first use). */
export interface AppAuthConfigs {
  authConfigFor(toolkit: string): Promise<string>;
}

export function createConnectionsService(store: Store, client: Client, authConfigs: Partial<Record<Toolkit, string>>, appBaseUrl: string, apps?: AppAuthConfigs) {
  const authConfigFor = async (toolkit: string): Promise<string | undefined> =>
    isBuiltinApp(toolkit) ? authConfigs[toolkit] : apps?.authConfigFor(toolkit);
  return {
    start: async (sessionId: string, toolkit: string) => {
      const authConfigId = await authConfigFor(toolkit);
      if (!authConfigId) throw new Error(`${toolkit} connection is unavailable`);
      const attemptId = crypto.randomUUID();
      // A per-attempt key rides only in the callback URL, which Composio keeps server-side: the consent link
      // it returns is opaque. Someone who sends a victim that link cannot finish the connection in their own
      // session, because only the browser that actually consents is redirected with the key.
      const key = randomBytes(24).toString('base64url');
      const callbackUrl = new URL('/api/connections/callback', appBaseUrl);
      callbackUrl.searchParams.set('attempt', attemptId);
      callbackUrl.searchParams.set('k', key);
      const link = await client.createLink(sessionId, authConfigId, callbackUrl.toString());
      await store.createConnectionAttempt(sessionId, attemptId, toolkit, link.accountId, authConfigId, link.expiresAt || new Date(Date.now() + 10 * 60_000).toISOString(), hashKey(key));
      return { attemptId, redirectUrl: link.redirectUrl };
    },
    finish: async (sessionId: string, attemptId: string, key?: string | null): Promise<string> => {
      const attempt = await store.getConnectionAttempt(sessionId, attemptId);
      if (!attempt || attempt.status !== 'pending') throw new Error('Connection attempt not found');
      if (!keyMatches(attempt.callbackHash, key)) throw new Error('Connection callback key mismatch');
      const account = await client.getAccount(attempt.accountId);
      const toolkit = account.toolkit as { slug?: string } | undefined;
      const authConfig = account.auth_config as { id?: string } | undefined;
      if (account.id !== attempt.accountId || account.user_id !== sessionId || account.status !== 'ACTIVE' ||
          toolkit?.slug !== composioToolkitSlug(attempt.toolkit) || authConfig?.id !== attempt.authConfigId) {
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
    disconnect: async (sessionId: string, toolkit: string): Promise<void> => {
      const accountId = await store.getActiveConnection(sessionId, toolkit);
      if (!accountId) return;
      await client.deleteAccount(accountId);
      if (!(await store.deactivateConnection(sessionId, toolkit, accountId))) throw new Error('Connection state changed during deletion');
    },
  };
}

interface AuthConfigStore {
  getAppAuthConfig(toolkit: string): Promise<string | undefined>;
  saveAppAuthConfig(toolkit: string, authConfigId: string): Promise<string>;
}

/** Creations in flight in this process, so a burst of first connects makes one auth config. */
const creating = new Map<string, Promise<string>>();

/**
 * One Composio-managed auth config per toolkit, created on the first connect and kept in
 * persona_auth_configs. When two servers race, the first saved row wins and both use it.
 */
export function createAppAuthConfigs(store: AuthConfigStore, client: { createManagedAuthConfig(toolkitSlug: string): Promise<string> }): AppAuthConfigs {
  return {
    authConfigFor: async (toolkit: string) => {
      if (isBuiltinApp(toolkit)) throw new Error('Gmail and Calendar use their configured auth configs');
      const existing = await store.getAppAuthConfig(toolkit);
      if (existing) return existing;
      let pending = creating.get(toolkit);
      if (!pending) {
        pending = client.createManagedAuthConfig(composioToolkitSlug(toolkit))
          .then((id) => store.saveAppAuthConfig(toolkit, id))
          .finally(() => creating.delete(toolkit));
        creating.set(toolkit, pending);
      }
      return pending;
    },
  };
}
