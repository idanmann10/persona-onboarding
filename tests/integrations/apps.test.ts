import { describe, expect, it } from 'vitest';
import { createToolkitCatalog, parseToolkits } from '../../lib/integrations/catalog';
import { createAppAuthConfigs, createConnectionsService } from '../../lib/integrations/connections';
import { createComposioClient } from '../../lib/integrations/composio';
import { createConnectionHandlers } from '../../lib/http/connections';
import { deletePersonaSession } from '../../lib/integrations/deletion';
import { listApps } from '../../lib/domain/apps';
import { projectSession } from '../../lib/domain/project';
import type { SessionEvent } from '../../lib/domain/events';

const toolkit = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug, name: slug.toUpperCase(), composio_managed_auth_schemes: ['OAUTH2'], no_auth: false,
  meta: { logo: `https://logos.composio.dev/api/${slug}`, categories: [{ id: 'productivity', name: 'Productivity' }] }, ...extra,
});

describe('Composio app catalog', () => {
  it('keeps managed-OAuth and no-auth toolkits, maps googlecalendar to calendar, and drops the rest', () => {
    const apps = parseToolkits([
      toolkit('slack'),
      toolkit('googlecalendar', { name: 'Google Calendar' }),
      toolkit('selfhosted', { composio_managed_auth_schemes: [] }),
      toolkit('hackernews', { composio_managed_auth_schemes: [], no_auth: true }),
      toolkit('old', { deprecated: true }),
      toolkit('Bad Slug!'),
      toolkit('insecure', { meta: { logo: 'http://example.com/x.png', categories: ['Dev'] } }),
    ]);
    expect(apps.map((app) => app.slug)).toEqual(['slack', 'calendar', 'hackernews', 'insecure']);
    expect(apps[0]).toEqual({ slug: 'slack', name: 'SLACK', logo: 'https://logos.composio.dev/api/slack', category: 'Productivity' });
    expect(apps[1].name).toBe('Google Calendar');
    expect(apps[2].noAuth).toBe(true);
    expect(apps[3]).toEqual({ slug: 'insecure', name: 'INSECURE', category: 'Dev' });
  });

  it('follows the cursor, sends the key, and caches the catalog for an hour', async () => {
    const urls: string[] = [];
    let now = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('key');
      const cursor = new URL(url).searchParams.get('cursor');
      return Response.json(cursor ? { items: [toolkit('notion')], next_cursor: null } : { items: [toolkit('slack')], next_cursor: 'page2' });
    }) as unknown as typeof fetch;
    const catalog = createToolkitCatalog('key', fetchFn, () => now);
    const [first, second] = await Promise.all([catalog.list(), catalog.list()]);
    expect(first.map((app) => app.slug)).toEqual(['slack', 'notion']);
    expect(second).toBe(first);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe('https://backend.composio.dev/api/v3/toolkits?limit=1000');
    expect(urls[1]).toContain('cursor=page2');
    now = 59 * 60_000;
    expect((await catalog.find('notion'))?.name).toBe('NOTION');
    expect(urls).toHaveLength(2);
    now = 61 * 60_000;
    await catalog.list();
    expect(urls).toHaveLength(4);
  });

  it('does not cache a failed fetch', async () => {
    let calls = 0;
    const catalog = createToolkitCatalog('key', (async () => { calls++; return calls === 1 ? new Response('down', { status: 502 }) : Response.json({ items: [toolkit('slack')] }); }) as unknown as typeof fetch);
    await expect(catalog.list()).rejects.toThrow('502');
    expect((await catalog.list()).map((app) => app.slug)).toEqual(['slack']);
  });

  it('lists connected apps first, then popular ones, filters by name or slug and caps the results', () => {
    const catalog = [
      { slug: 'zendesk', name: 'Zendesk' }, { slug: 'notion', name: 'Notion' }, { slug: 'slack', name: 'Slack' },
      { slug: 'gmail', name: 'Gmail' }, { slug: 'asana', name: 'Asana' }, { slug: 'microsoft_teams', name: 'Microsoft Teams' },
    ];
    expect(listApps(catalog, ['zendesk']).map((app) => app.slug)).toEqual(['zendesk', 'gmail', 'slack', 'notion', 'microsoft_teams', 'asana']);
    expect(listApps(catalog, [], 'TEAMS')).toEqual([{ slug: 'microsoft_teams', name: 'Microsoft Teams', connected: false }]);
    expect(listApps(catalog, [], 'microsoft_')).toHaveLength(1);
    expect(listApps(catalog, [], '', 2)).toHaveLength(2);
  });
});

describe('Composio managed auth configs', () => {
  it('creates a managed auth config with the v3 body shape', async () => {
    let seen: { url: string; body: unknown } | undefined;
    const client = createComposioClient('key', (async (url: string, init?: RequestInit) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return Response.json({ toolkit: { slug: 'slack' }, auth_config: { id: 'ac_slack123', is_composio_managed: true } });
    }) as unknown as typeof fetch);
    expect(await client.createManagedAuthConfig('slack')).toBe('ac_slack123');
    expect(seen).toEqual({ url: 'https://backend.composio.dev/api/v3/auth_configs', body: { toolkit: { slug: 'slack' }, auth_config: { type: 'use_composio_managed_auth', name: 'Persona slack' } } });
  });

  it('creates one auth config per toolkit and reuses the saved one', async () => {
    const saved = new Map<string, string>();
    let created = 0;
    const configs = createAppAuthConfigs({
      getAppAuthConfig: async (slug) => saved.get(slug),
      saveAppAuthConfig: async (slug, id) => { if (!saved.has(slug)) saved.set(slug, id); return saved.get(slug)!; },
    }, { createManagedAuthConfig: async (slug) => { created++; return `ac_${slug}_${created}`; } });
    const [a, b] = await Promise.all([configs.authConfigFor('slack'), configs.authConfigFor('slack')]);
    expect(a).toBe('ac_slack_1');
    expect(b).toBe('ac_slack_1');
    expect(await configs.authConfigFor('slack')).toBe('ac_slack_1');
    expect(created).toBe(1);
    await expect(configs.authConfigFor('gmail')).rejects.toThrow();
  });
});

describe('connecting a generic app', () => {
  function fakeStore() {
    const rows: Array<{ sessionId: string; attemptId: string; toolkit: string; accountId: string; authConfigId: string; status: string }> = [];
    return {
      rows,
      createConnectionAttempt: async (sessionId: string, attemptId: string, toolkit: string, accountId: string, authConfigId: string) => { rows.push({ sessionId, attemptId, toolkit, accountId, authConfigId, status: 'pending' }); },
      getConnectionAttempt: async (sessionId: string, attemptId: string) => rows.find((row) => row.sessionId === sessionId && row.attemptId === attemptId),
      activateConnection: async (sessionId: string, attemptId: string) => {
        const row = rows.find((item) => item.sessionId === sessionId && item.attemptId === attemptId && item.status === 'pending');
        if (!row) return false;
        for (const other of rows) if (other.sessionId === sessionId && other.toolkit === row.toolkit && other.status === 'active') other.status = 'superseded';
        row.status = 'active';
        return true;
      },
      getActiveConnection: async (sessionId: string, toolkit: string) => rows.find((row) => row.sessionId === sessionId && row.toolkit === toolkit && row.status === 'active')?.accountId,
      deactivateConnection: async (sessionId: string, toolkit: string, accountId: string) => {
        const row = rows.find((item) => item.sessionId === sessionId && item.toolkit === toolkit && item.accountId === accountId && item.status === 'active');
        if (row) row.status = 'superseded';
        return Boolean(row);
      },
      listConnectionAccounts: async (sessionId: string) => rows.filter((row) => row.sessionId === sessionId && row.status !== 'superseded').map((row) => row.accountId),
    };
  }

  it('links through a managed auth config, verifies the Slack account, and disconnects it', async () => {
    const store = fakeStore();
    const deleted: string[] = [];
    const links: string[] = [];
    const client = {
      createLink: async (_user: string, authConfigId: string) => { links.push(authConfigId); return { accountId: 'ca_slack', redirectUrl: 'https://connect.composio.dev/link/x' }; },
      getAccount: async () => ({ id: 'ca_slack', user_id: 'owner', status: 'ACTIVE', toolkit: { slug: 'slack' }, auth_config: { id: 'ac_slack' } }),
      deleteAccount: async (id: string) => { deleted.push(id); },
    };
    const service = createConnectionsService(store, client, { gmail: 'auth_gmail' }, 'https://persona.example', { authConfigFor: async (slug) => `ac_${slug}` });
    const link = await service.start('owner', 'slack');
    expect(links).toEqual(['ac_slack']);
    expect(store.rows[0]).toMatchObject({ toolkit: 'slack', accountId: 'ca_slack', authConfigId: 'ac_slack' });
    await expect(service.finish('stranger', link.attemptId)).rejects.toThrow();
    expect(await service.finish('owner', link.attemptId)).toBe('slack');
    expect(await store.getActiveConnection('owner', 'slack')).toBe('ca_slack');
    await service.disconnect('owner', 'slack');
    expect(deleted).toEqual(['ca_slack']);
    expect(await store.getActiveConnection('owner', 'slack')).toBeUndefined();
  });

  it('rejects an account whose toolkit is not the app that was asked for', async () => {
    const store = fakeStore();
    const service = createConnectionsService(store, {
      createLink: async () => ({ accountId: 'ca_x', redirectUrl: 'https://connect.composio.dev/link/x' }),
      getAccount: async () => ({ id: 'ca_x', user_id: 'owner', status: 'ACTIVE', toolkit: { slug: 'github' }, auth_config: { id: 'ac_slack' } }),
      deleteAccount: async () => undefined,
    }, {}, 'https://persona.example', { authConfigFor: async (slug) => `ac_${slug}` });
    const link = await service.start('owner', 'slack');
    await expect(service.finish('owner', link.attemptId)).rejects.toThrow('verification');
    expect(await store.getActiveConnection('owner', 'slack')).toBeUndefined();
  });

  it('Start over revokes generic app accounts along with Gmail', async () => {
    const store = fakeStore();
    const service = createConnectionsService(store, {
      createLink: async (_user: string, authConfigId: string) => ({ accountId: authConfigId === 'auth_gmail' ? 'ca_gmail' : 'ca_notion', redirectUrl: 'https://connect.composio.dev/link/x' }),
      getAccount: async () => ({}),
      deleteAccount: async () => undefined,
    }, { gmail: 'auth_gmail' }, 'https://persona.example', { authConfigFor: async (slug) => `ac_${slug}` });
    await service.start('owner', 'gmail');
    await service.start('owner', 'notion');
    const revoked: string[] = [];
    let localDeleted = false;
    await deletePersonaSession({ listConnectionAccounts: store.listConnectionAccounts, deleteSession: async () => { localDeleted = true; } }, { deleteAccount: async (id) => { revoked.push(id); } }, 'owner');
    expect(revoked).toEqual(['ca_gmail', 'ca_notion']);
    expect(localDeleted).toBe(true);
  });
});

describe('Apps HTTP contract', () => {
  const origin = 'https://persona.example';
  const attemptId = '123e4567-e89b-42d3-a456-426614174000';
  const catalogApps = [
    { slug: 'gmail', name: 'Gmail' }, { slug: 'calendar', name: 'Google Calendar' }, { slug: 'slack', name: 'Slack', logo: 'https://logos.composio.dev/api/slack', category: 'Communication' },
    { slug: 'notion', name: 'Notion' }, { slug: 'hackernews', name: 'Hacker News', noAuth: true },
  ];
  const catalog = { list: async () => catalogApps, find: async (slug: string) => catalogApps.find((app) => app.slug === slug) };
  function setup(overrides: { finish?: () => Promise<string>; ipAllowed?: boolean } = {}) {
    const events: SessionEvent[] = [];
    const started: string[] = [];
    const disconnected: string[] = [];
    const active = new Set(['slack']);
    const store = {
      sessionExists: async (id: string) => id === 'owner',
      getActiveConnection: async (_id: string, slug: string) => active.has(slug) ? `ca_${slug}` : undefined,
      getConnectionAttempt: async () => ({ toolkit: 'notion', status: 'pending' }),
      appendEvent: async (_id: string, event: SessionEvent) => { events.push(event); },
      listActiveConnectionToolkits: async () => [...active],
      consumeIpQuota: async () => overrides.ipAllowed ?? true,
    };
    const service = {
      start: async (_id: string, slug: string) => { started.push(slug); return { attemptId, redirectUrl: 'https://connect.composio.dev/link/x' }; },
      finish: overrides.finish ?? (async () => 'notion'),
      disconnect: async (_id: string, slug: string) => { disconnected.push(slug); active.delete(slug); },
    };
    return { events, started, disconnected, handlers: createConnectionHandlers(store, service, origin, catalog) };
  }
  const json = (method: string, body: unknown, cookie = 'owner') => new Request(`${origin}/api/connections`, { method, headers: { origin, cookie: `persona_session=${cookie}` }, body: JSON.stringify(body) });

  it('lists the catalog with connected flags and filters with ?q=', async () => {
    const { handlers } = setup();
    expect((await handlers.status(new Request(`${origin}/api/connections`))).status).toBe(401);
    const body = await (await handlers.status(new Request(`${origin}/api/connections`, { headers: { cookie: 'persona_session=owner' } }))).json();
    expect(body.gmail).toBe(false);
    expect(body.apps[0]).toEqual({ slug: 'slack', name: 'Slack', logo: 'https://logos.composio.dev/api/slack', category: 'Communication', connected: true });
    expect(body.apps.map((app: { slug: string }) => app.slug)).toEqual(['slack', 'gmail', 'calendar', 'notion', 'hackernews']);
    const search = await (await handlers.status(new Request(`${origin}/api/connections?q=NOT`, { headers: { cookie: 'persona_session=owner' } }))).json();
    expect(search.apps).toEqual([{ slug: 'notion', name: 'Notion', connected: false }]);
  });

  it('starts a connection only for a valid catalog slug that needs sign-in, within the network limit', async () => {
    const { handlers, started } = setup();
    expect(await (await handlers.start(json('POST', { toolkit: 'notion' }))).json()).toEqual({ redirectUrl: 'https://connect.composio.dev/link/x' });
    expect((await handlers.start(json('POST', { toolkit: 'googlecalendar' }))).status).toBe(200);
    expect((await handlers.start(json('POST', { toolkit: 'Notion; DROP' }))).status).toBe(400);
    expect((await handlers.start(json('POST', { toolkit: 'x'.repeat(61) }))).status).toBe(400);
    expect((await handlers.start(json('POST', { toolkit: 'not_in_catalog' }))).status).toBe(400);
    expect((await handlers.start(json('POST', { toolkit: 'hackernews' }))).status).toBe(400);
    expect((await handlers.start(json('POST', { toolkit: 'notion' }, 'stranger'))).status).toBe(401);
    expect(started).toEqual(['notion', 'calendar']);
    const limited = setup({ ipAllowed: false });
    expect((await limited.handlers.start(json('POST', { toolkit: 'notion' }))).status).toBe(429);
    expect(limited.started).toEqual([]);
  });

  it('finishes a generic app callback with an app_connection event and the slug the UI sent', async () => {
    const { handlers, events } = setup();
    const page = await handlers.callback(new Request(`${origin}/api/connections/callback?attempt=${attemptId}`, { headers: { cookie: 'persona_session=owner' } }));
    const html = await page.text();
    expect(html).toContain('"type":"persona-connection","toolkit":"notion","status":"connected"');
    expect(html).toContain('https://persona.example/?connection=notion');
    expect(events).toEqual([expect.objectContaining({ type: 'app_connection', app: 'notion', name: 'Notion', phase: 'connected' })]);
    expect(events.some((event) => event.type === 'connection')).toBe(false);
  });

  it('records a failed generic callback as an app_connection failure', async () => {
    const { handlers, events } = setup({ finish: async () => { throw new Error('not active'); } });
    const page = await handlers.callback(new Request(`${origin}/api/connections/callback?attempt=${attemptId}`, { headers: { cookie: 'persona_session=owner' } }));
    expect(await page.text()).toContain('"toolkit":"notion","status":"failed"');
    expect(events).toEqual([expect.objectContaining({ type: 'app_connection', app: 'notion', phase: 'failed' })]);
  });

  it('disconnects a generic app with a 204 and an app_connection event', async () => {
    const { handlers, events, disconnected } = setup();
    expect((await handlers.disconnect(json('DELETE', { toolkit: 'slack' }, 'stranger'))).status).toBe(401);
    expect((await handlers.disconnect(new Request(`${origin}/api/connections`, { method: 'DELETE', headers: { origin: 'https://evil.example', cookie: 'persona_session=owner' }, body: JSON.stringify({ toolkit: 'slack' }) }))).status).toBe(403);
    expect((await handlers.disconnect(json('DELETE', { toolkit: 'slack' }))).status).toBe(204);
    expect(disconnected).toEqual(['slack']);
    expect(events).toEqual([expect.objectContaining({ type: 'app_connection', app: 'slack', name: 'Slack', phase: 'disconnected' })]);
  });

  it('projects connected apps, and a failed reconnect keeps the earlier connection', () => {
    const at = new Date().toISOString();
    const state = projectSession([
      { id: 'a1', at, type: 'app_connection', app: 'slack', name: 'Slack', phase: 'connected' },
      { id: 'a2', at, type: 'app_connection', app: 'slack', name: 'Slack', phase: 'failed' },
      { id: 'a3', at, type: 'app_connection', app: 'notion', name: 'Notion', phase: 'connected' },
      { id: 'a4', at, type: 'app_connection', app: 'notion', name: 'Notion', phase: 'disconnected' },
    ]);
    expect(state.apps).toEqual({ slack: { name: 'Slack', phase: 'connected' }, notion: { name: 'Notion', phase: 'disconnected' } });
  });
});

describe('agent awareness of connected apps', () => {
  it("lists a connected app as a capability it can't act in yet, and drops a disconnected one", async () => {
    const { prepareTurn } = await import('../../lib/agent/turn');
    const at = '2026-09-27T12:00:00.000Z';
    const history: SessionEvent[] = [
      { id: 'm1', at, type: 'message', speaker: 'user', channel: 'text', text: 'hi' },
      { id: 'a1', at, type: 'app_connection', app: 'slack', name: 'Slack', phase: 'connected' },
      { id: 'a2', at, type: 'app_connection', app: 'notion', name: 'Notion', phase: 'connected' },
      { id: 'a3', at, type: 'app_connection', app: 'notion', name: 'Notion', phase: 'disconnected' },
    ];
    const deps = { store: { appendEvent: async () => undefined, getActiveConnection: async () => undefined }, env: { OPENAI_API_KEY: 'k', OPENAI_TEXT_MODEL: 'gpt-6-luna' } };
    const turn = await prepareTurn(deps, 's1', history, { turnId: 'm1' });
    expect(turn.instructions).toContain("Slack (connected; you can't act in it yet — say so honestly)");
    expect(turn.instructions).not.toContain('Notion (connected');
  });
});
