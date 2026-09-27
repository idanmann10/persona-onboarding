import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createStore } from '../../lib/db/store';
import { createAppAuthConfigs, createConnectionsService } from '../../lib/integrations/connections';
import { deletePersonaSession } from '../../lib/integrations/deletion';

const database = `persona_apps_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const adminUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL || 'postgres://localhost/postgres');
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = postgres(adminUrl.toString(), { max: 1 });
let sql: ReturnType<typeof postgres>;

describe('Postgres store for generic app connections', () => {
  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${database} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
    sql = postgres(testUrl.toString(), { max: 1, onnotice: () => undefined });
    await createStore(sql).initialize();
  });

  afterAll(async () => {
    if (sql) await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  });

  it('relaxes the legacy Gmail/Calendar check idempotently and still rejects unsafe slugs', async () => {
    // A database created before this change carries the old auto-named list check.
    await sql.unsafe(`ALTER TABLE persona_connections DROP CONSTRAINT persona_connections_toolkit_slug;
      ALTER TABLE persona_connections ADD CONSTRAINT persona_connections_toolkit_check CHECK (toolkit IN ('gmail', 'calendar'))`);
    const store = createStore(sql);
    await store.initialize();
    await store.initialize();
    const sessionId = crypto.randomUUID();
    await store.createSession(sessionId);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await sql`INSERT INTO persona_connections (attempt_id, session_id, toolkit, connected_account_id, auth_config_id, expires_at)
      VALUES (${crypto.randomUUID()}, ${sessionId}, 'microsoft_teams', 'ca_teams', 'ac_teams', ${expiresAt})`;
    await expect(sql`INSERT INTO persona_connections (attempt_id, session_id, toolkit, connected_account_id, auth_config_id, expires_at)
      VALUES (${crypto.randomUUID()}, ${sessionId}, 'Bad Slug', 'ca_bad', 'ac_bad', ${expiresAt})`).rejects.toThrow();
  });

  it('keeps the first auth config saved for a toolkit', async () => {
    const store = createStore(sql);
    expect(await store.getAppAuthConfig('slack')).toBeUndefined();
    expect(await store.saveAppAuthConfig('slack', 'ac_first')).toBe('ac_first');
    expect(await store.saveAppAuthConfig('slack', 'ac_second')).toBe('ac_first');
    const configs = createAppAuthConfigs(store, { createManagedAuthConfig: async () => { throw new Error('must reuse the saved config'); } });
    expect(await configs.authConfigFor('slack')).toBe('ac_first');
  });

  it('connects a generic app for one session only, and Start over revokes it', async () => {
    const store = createStore(sql);
    const owner = crypto.randomUUID();
    const stranger = crypto.randomUUID();
    await store.createSession(owner);
    await store.createSession(stranger);
    const client = {
      createLink: async () => ({ accountId: 'ca_notion_owner', redirectUrl: 'https://connect.composio.dev/link/x' }),
      getAccount: async () => ({ id: 'ca_notion_owner', user_id: owner, status: 'ACTIVE', toolkit: { slug: 'notion' }, auth_config: { id: 'ac_notion' } }),
      deleteAccount: async () => undefined,
    };
    const service = createConnectionsService(store, client, {}, 'https://persona.example', { authConfigFor: async () => 'ac_notion' });
    const link = await service.start(owner, 'notion');
    await expect(service.finish(stranger, link.attemptId)).rejects.toThrow();
    expect(await service.finish(owner, link.attemptId)).toBe('notion');
    expect(await store.listActiveConnectionToolkits(owner)).toEqual(['notion']);
    expect(await store.listActiveConnectionToolkits(stranger)).toEqual([]);
    const revoked: string[] = [];
    await deletePersonaSession(store, { deleteAccount: async (id) => { revoked.push(id); } }, owner);
    expect(revoked).toEqual(['ca_notion_owner']);
    expect(await store.sessionExists(owner)).toBe(false);
  });
});
