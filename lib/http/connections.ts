import { readSessionCookie } from './session';
import type { Toolkit } from '../integrations/connections';

interface Store {
  sessionExists(id: string): Promise<boolean>;
  getActiveConnection(id: string, toolkit: Toolkit): Promise<string | undefined>;
}
interface Service {
  start(id: string, toolkit: Toolkit): Promise<{ attemptId: string; redirectUrl: string }>;
  finish(id: string, attemptId: string): Promise<Toolkit>;
  disconnect(id: string, toolkit: Toolkit): Promise<void>;
}

export function createConnectionHandlers(store: Store, service: Service, appBaseUrl: string) {
  const ownedSession = async (request: Request) => {
    const id = readSessionCookie(request);
    return id && await store.sessionExists(id) ? id : undefined;
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
      let body: { toolkit?: unknown };
      try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      if (body.toolkit !== 'calendar' && body.toolkit !== 'gmail') return new Response('Unsupported connection', { status: 400 });
      try {
        const link = await service.start(id, body.toolkit);
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
      let body: { toolkit?: unknown };
      try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      if (body.toolkit !== 'calendar' && body.toolkit !== 'gmail') return new Response('Unsupported connection', { status: 400 });
      try { await service.disconnect(id, body.toolkit); return new Response(null, { status: 204 }); }
      catch (error) { console.error('Connection deletion failed', error); return new Response('Connection deletion failed', { status: 503 }); }
    },
    callback: async (request: Request): Promise<Response> => {
      const id = await ownedSession(request);
      if (!id) return new Response('Session required', { status: 401 });
      const attemptId = new URL(request.url).searchParams.get('attempt');
      if (!attemptId || !/^[0-9a-f-]{36}$/i.test(attemptId)) return new Response('Invalid connection attempt', { status: 400 });
      try {
        const toolkit = await service.finish(id, attemptId);
        return Response.redirect(new URL(`/?connection=${toolkit}`, appBaseUrl), 303);
      } catch (error) {
        console.error('Connection callback failed', error);
        return Response.redirect(new URL('/?connection=failed', appBaseUrl), 303);
      }
    },
  };
}
