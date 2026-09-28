import { signedInSession, type LoginStore } from '../auth/login';
import { withinIpLimit, type IpQuotaStore } from './client-key';
import { fallbackAppName, isAppSlug, isBuiltinApp, listApps, type AppEntry, type BuiltinApp } from '../domain/apps';
import type { SessionEvent } from '../domain/events';
import { SNAPSHOT_APPS } from '../integrations/catalog';

interface Store extends IpQuotaStore, LoginStore {
  getActiveConnection(id: string, toolkit: string): Promise<string | undefined>;
  getConnectionAttempt(sessionId: string, attemptId: string): Promise<{ toolkit: string; status?: string } | undefined>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  /** Every active toolkit for the session; without it only Gmail and Calendar are checked. */
  listActiveConnectionToolkits?(id: string): Promise<string[]>;
}
interface Service {
  start(id: string, toolkit: string): Promise<{ attemptId: string; redirectUrl: string }>;
  finish(id: string, attemptId: string, key?: string | null): Promise<string>;
  disconnect(id: string, toolkit: string): Promise<void>;
}
interface Catalog {
  list(): Promise<AppEntry[]>;
  find(slug: string): Promise<AppEntry | undefined>;
}

/**
 * The OAuth callback page. Opened as a popup (the normal path, so a live call survives), it tells the
 * chat window and closes itself; opened as a full-page redirect, it returns to the chat. `toolkit` is
 * the slug the UI sent ('gmail', 'calendar', or any other app slug).
 */
export function callbackPage(appBaseUrl: string, toolkit: string | undefined, status: 'connected' | 'failed'): Response {
  const target = new URL(`/?connection=${status === 'connected' && toolkit ? encodeURIComponent(toolkit) : 'failed'}`, appBaseUrl);
  const message = JSON.stringify({ type: 'persona-connection', toolkit: toolkit ?? null, status });
  const text = status === 'connected' ? 'Connected. You can close this window.' : "The connection didn't finish. You can close this window.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Persona</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 Inter,system-ui,sans-serif;background:#fbfaf7;color:#161616}</style></head>
<body><p>${text}</p><script>
(function () {
  var message = ${message};
  if (window.opener && window.opener !== window) {
    try { window.opener.postMessage(message, ${JSON.stringify(new URL(appBaseUrl).origin)}); } catch (error) {}
    window.close();
  } else { window.location.replace(${JSON.stringify(target.toString())}); }
})();
</script></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export function createConnectionHandlers(store: Store, service: Service, appBaseUrl: string, catalog?: Catalog) {
  const ownedSession = (request: Request) => signedInSession(store, request);
  const bodyToolkit = async (request: Request): Promise<unknown> => {
    try { return ((await request.json()) as { toolkit?: unknown }).toolkit; } catch { return undefined; }
  };
  /** Gmail or Calendar only: the in-chat Connect cards. */
  const builtinFrom = async (request: Request): Promise<BuiltinApp | undefined> => {
    const toolkit = await bodyToolkit(request);
    return toolkit === 'calendar' || toolkit === 'gmail' ? toolkit : undefined;
  };
  /** Any app slug; Composio's 'googlecalendar' is our 'calendar'. */
  const slugFrom = async (request: Request): Promise<string | undefined> => {
    const toolkit = await bodyToolkit(request);
    if (!isAppSlug(toolkit)) return undefined;
    return toolkit === 'googlecalendar' ? 'calendar' : toolkit;
  };
  const nameFor = async (slug: string): Promise<string> => {
    try { return (await catalog?.find(slug))?.name ?? fallbackAppName(slug); } catch { return fallbackAppName(slug); }
  };
  const connectedToolkits = async (id: string): Promise<string[]> => {
    if (store.listActiveConnectionToolkits) return store.listActiveConnectionToolkits(id);
    const builtins: BuiltinApp[] = ['gmail', 'calendar'];
    const active = await Promise.all(builtins.map(async (toolkit) => (await store.getActiveConnection(id, toolkit)) ? toolkit : undefined));
    return active.filter((toolkit): toolkit is BuiltinApp => Boolean(toolkit));
  };
  const appEvent = async (id: string, app: string, phase: 'connected' | 'disconnected' | 'failed', eventId: string) => {
    await store.appendEvent(id, { id: eventId, at: new Date().toISOString(), type: 'app_connection', app, name: await nameFor(app), phase });
  };
  /**
   * Success path of the OAuth callback: the account is verified and active for this session. Runs once
   * per attempt (a reload of a finished callback skips it).
   */
  const onConnected = async (id: string, toolkit: string, attemptId: string): Promise<void> => {
    if (isBuiltinApp(toolkit)) {
      await store.appendEvent(id, { id: `connection:${toolkit}:${attemptId}:connected`, at: new Date().toISOString(), type: 'connection', toolkit, phase: 'connected' });
    } else {
      await appEvent(id, toolkit, 'connected', `app:${toolkit}:${attemptId}:connected`);
    }
  };
  return {
    /**
     * GET /api/connections[?q=]: apps with the session's status. The Apps sheet lists and searches the
     * bundled snapshot itself and only asks here with `q` when the snapshot has no match, so only a
     * search reads the live catalog; without `q` this answers from the snapshot. `gmail`/`calendar`
     * booleans stay for older clients.
     */
    status: async (request: Request): Promise<Response> => {
      const id = await ownedSession(request);
      if (!id) return new Response('Session required', { status: 401 });
      const query = new URL(request.url).searchParams.get('q')?.slice(0, 100).trim();
      const [connected, live] = await Promise.all([
        connectedToolkits(id),
        query && catalog ? catalog.list().catch((error) => { console.error('App catalog unavailable', error); return undefined; }) : undefined,
      ]);
      let entries: readonly AppEntry[] = live ?? SNAPSHOT_APPS;
      for (const app of SNAPSHOT_APPS) if (isBuiltinApp(app.slug) && !entries.some((entry) => entry.slug === app.slug)) entries = [app, ...entries];
      return Response.json({
        calendar: connected.includes('calendar'),
        gmail: connected.includes('gmail'),
        // No-auth toolkits have nothing to connect: a Connect button there could only fail.
        apps: listApps(entries.filter((app) => !app.noAuth), connected, query),
      }, { headers: { 'Cache-Control': 'no-store' } });
    },
    /**
     * GET /api/connections/status: only the slugs this session has connected. One database read and no
     * Composio call, so the page can prefetch it and the Apps sheet opens with it already known.
     */
    connected: async (request: Request): Promise<Response> => {
      const id = await ownedSession(request);
      if (!id) return new Response('Session required', { status: 401 });
      return Response.json({ connected: await connectedToolkits(id) }, { headers: { 'Cache-Control': 'no-store' } });
    },
    /** POST /api/connections {toolkit}: a Composio sign-in link for any catalog app. */
    start: async (request: Request): Promise<Response> => {
      const id = await ownedSession(request);
      if (!id) return new Response('Session required', { status: 401 });
      if (request.headers.get('origin') !== new URL(appBaseUrl).origin) return new Response('Origin mismatch', { status: 403 });
      const toolkit = await slugFrom(request);
      if (!toolkit) return new Response('Unsupported connection', { status: 400 });
      if (!isBuiltinApp(toolkit)) {
        let app: AppEntry | undefined;
        try { app = await catalog?.find(toolkit); }
        catch (error) { console.error('App catalog unavailable', error); return new Response('Connection unavailable', { status: 503 }); }
        if (!app) return new Response('Unsupported connection', { status: 400 });
        if (app.noAuth) return new Response('This app needs no connection', { status: 400 });
      }
      if (!(await withinIpLimit(store, request, 'tool'))) return new Response('Too many connection attempts; try again later', { status: 429 });
      try {
        const link = await service.start(id, toolkit);
        return Response.json({ redirectUrl: link.redirectUrl }, { headers: { 'Cache-Control': 'no-store' } });
      } catch (error) {
        console.error('Connection start failed', error);
        return new Response('Connection unavailable', { status: 503 });
      }
    },
    /** DELETE /api/connections {toolkit}: revokes the session's account for that app. */
    disconnect: async (request: Request): Promise<Response> => {
      const id = await ownedSession(request);
      if (!id) return new Response('Session required', { status: 401 });
      if (request.headers.get('origin') !== new URL(appBaseUrl).origin) return new Response('Origin mismatch', { status: 403 });
      const toolkit = await slugFrom(request);
      if (!toolkit) return new Response('Unsupported connection', { status: 400 });
      try {
        const wasConnected = Boolean(await store.getActiveConnection(id, toolkit));
        await service.disconnect(id, toolkit);
        if (isBuiltinApp(toolkit)) {
          await store.appendEvent(id, { id: `connection:${toolkit}:disconnected:${crypto.randomUUID()}`, at: new Date().toISOString(), type: 'connection', toolkit, phase: 'disconnected' });
        } else if (wasConnected) {
          await appEvent(id, toolkit, 'disconnected', `app:${toolkit}:disconnected:${crypto.randomUUID()}`);
        }
        return new Response(null, { status: 204 });
      } catch (error) { console.error('Connection deletion failed', error); return new Response('Connection deletion failed', { status: 503 }); }
    },
    /** "Not now" on an in-chat Connect card (Gmail or Calendar). */
    decline: async (request: Request): Promise<Response> => {
      const id = await ownedSession(request);
      if (!id) return new Response('Session required', { status: 401 });
      if (request.headers.get('origin') !== new URL(appBaseUrl).origin) return new Response('Origin mismatch', { status: 403 });
      const toolkit = await builtinFrom(request);
      if (!toolkit) return new Response('Unsupported connection', { status: 400 });
      if (await store.getActiveConnection(id, toolkit)) return new Response(null, { status: 204 });
      await store.appendEvent(id, { id: `connection:${toolkit}:declined:${crypto.randomUUID()}`, at: new Date().toISOString(), type: 'connection', toolkit, phase: 'declined' });
      return new Response(null, { status: 204 });
    },
    callback: async (request: Request): Promise<Response> => {
      const id = await ownedSession(request);
      if (!id) return new Response('Session required', { status: 401 });
      const attemptId = new URL(request.url).searchParams.get('attempt');
      if (!attemptId || !/^[0-9a-f-]{36}$/i.test(attemptId)) return new Response('Invalid connection attempt', { status: 400 });
      const attempt = await store.getConnectionAttempt(id, attemptId);
      // A reload or second visit of a callback that already succeeded is not a failure.
      if (attempt?.status === 'active') return callbackPage(appBaseUrl, attempt.toolkit, 'connected');
      let toolkit: string;
      try {
        toolkit = await service.finish(id, attemptId, new URL(request.url).searchParams.get('k'));
      } catch (error) {
        console.error('Connection callback failed', error);
        if (attempt?.status === 'pending') {
          try {
            if (isBuiltinApp(attempt.toolkit)) await store.appendEvent(id, { id: `connection:${attempt.toolkit}:${attemptId}:failed`, at: new Date().toISOString(), type: 'connection', toolkit: attempt.toolkit, phase: 'failed' });
            else await appEvent(id, attempt.toolkit, 'failed', `app:${attempt.toolkit}:${attemptId}:failed`);
          } catch (eventError) { console.error('Connection failure event failed', eventError); }
        }
        return callbackPage(appBaseUrl, attempt?.toolkit, 'failed');
      }
      // ---- Success path: the account is connected; everything that reacts to it lives in onConnected. ----
      try { await onConnected(id, toolkit, attemptId); }
      catch (error) { console.error('Connection success follow-up failed', error); }
      return callbackPage(appBaseUrl, toolkit, 'connected');
    },
  };
}
