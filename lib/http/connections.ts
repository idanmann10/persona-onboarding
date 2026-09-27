import { readSessionCookie } from './session';
import type { Toolkit } from '../integrations/connections';
import type { SessionEvent } from '../domain/events';

interface Store {
  sessionExists(id: string): Promise<boolean>;
  getActiveConnection(id: string, toolkit: Toolkit): Promise<string | undefined>;
  getConnectionAttempt(sessionId: string, attemptId: string): Promise<{ toolkit: Toolkit } | undefined>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
}
interface Service {
  start(id: string, toolkit: Toolkit): Promise<{ attemptId: string; redirectUrl: string }>;
  finish(id: string, attemptId: string): Promise<Toolkit>;
  disconnect(id: string, toolkit: Toolkit): Promise<void>;
}

/**
 * The OAuth callback page. Opened as a popup (the normal path, so a live call survives), it tells the
 * chat window and closes itself; opened as a full-page redirect, it returns to the chat.
 */
export function callbackPage(appBaseUrl: string, toolkit: Toolkit | undefined, status: 'connected' | 'failed'): Response {
  const target = new URL(`/?connection=${status === 'connected' && toolkit ? toolkit : 'failed'}`, appBaseUrl);
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

export function createConnectionHandlers(store: Store, service: Service, appBaseUrl: string) {
  const ownedSession = async (request: Request) => {
    const id = readSessionCookie(request);
    return id && await store.sessionExists(id) ? id : undefined;
  };
  const toolkitFrom = async (request: Request): Promise<Toolkit | undefined> => {
    try {
      const body = await request.json() as { toolkit?: unknown };
      return body.toolkit === 'calendar' || body.toolkit === 'gmail' ? body.toolkit : undefined;
    } catch { return undefined; }
  };
  return {
    status: async (request: Request): Promise<Response> => {
      const id = await ownedSession(request);
      if (!id) return new Response('Session required', { status: 401 });
      return Response.json({
        calendar: Boolean(await store.getActiveConnection(id, 'calendar')),
        gmail: Boolean(await store.getActiveConnection(id, 'gmail')),
      }, { headers: { 'Cache-Control': 'no-store' } });
    },
    start: async (request: Request): Promise<Response> => {
      const id = await ownedSession(request);
      if (!id) return new Response('Session required', { status: 401 });
      if (request.headers.get('origin') !== new URL(appBaseUrl).origin) return new Response('Origin mismatch', { status: 403 });
      const toolkit = await toolkitFrom(request);
      if (!toolkit) return new Response('Unsupported connection', { status: 400 });
      try {
        const link = await service.start(id, toolkit);
        return Response.json({ redirectUrl: link.redirectUrl }, { headers: { 'Cache-Control': 'no-store' } });
      } catch (error) {
        console.error('Connection start failed', error);
        return new Response('Connection unavailable', { status: 503 });
      }
    },
    disconnect: async (request: Request): Promise<Response> => {
      const id = await ownedSession(request);
      if (!id) return new Response('Session required', { status: 401 });
      if (request.headers.get('origin') !== new URL(appBaseUrl).origin) return new Response('Origin mismatch', { status: 403 });
      const toolkit = await toolkitFrom(request);
      if (!toolkit) return new Response('Unsupported connection', { status: 400 });
      try {
        await service.disconnect(id, toolkit);
        await store.appendEvent(id, { id: `connection:${toolkit}:disconnected:${crypto.randomUUID()}`, at: new Date().toISOString(), type: 'connection', toolkit, phase: 'disconnected' });
        return new Response(null, { status: 204 });
      } catch (error) { console.error('Connection deletion failed', error); return new Response('Connection deletion failed', { status: 503 }); }
    },
    /** "Not now" on an in-chat Connect card. */
    decline: async (request: Request): Promise<Response> => {
      const id = await ownedSession(request);
      if (!id) return new Response('Session required', { status: 401 });
      if (request.headers.get('origin') !== new URL(appBaseUrl).origin) return new Response('Origin mismatch', { status: 403 });
      const toolkit = await toolkitFrom(request);
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
      try {
        const toolkit = await service.finish(id, attemptId);
        await store.appendEvent(id, { id: `connection:${toolkit}:${attemptId}:connected`, at: new Date().toISOString(), type: 'connection', toolkit, phase: 'connected' });
        return callbackPage(appBaseUrl, toolkit, 'connected');
      } catch (error) {
        console.error('Connection callback failed', error);
        if (attempt) await store.appendEvent(id, { id: `connection:${attempt.toolkit}:${attemptId}:failed`, at: new Date().toISOString(), type: 'connection', toolkit: attempt.toolkit, phase: 'failed' });
        return callbackPage(appBaseUrl, attempt?.toolkit, 'failed');
      }
    },
  };
}
