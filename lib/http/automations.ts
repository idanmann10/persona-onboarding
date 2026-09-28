import type { SessionEvent } from '../domain/events';
import { scheduleOf, type AutomationStore } from '../domain/automation';
import { describeSchedule, isValidTimeZone, nextRun } from '../domain/schedule';
import { runAutomation, type AutomationRunDependencies } from '../agent/automation-run';
import type { TurnTrigger } from '../agent/turn';
import { signedInSession, type LoginStore } from '../auth/login';
import { withinIpLimit, type IpQuotaStore } from './client-key';
import { sameOrigin } from './origin';

interface Store extends AutomationStore, IpQuotaStore, LoginStore {
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  consumeQuota(id: string, scope: 'chat', limit: number, windowSeconds: number): Promise<boolean>;
}

type Generate = (history: SessionEvent[], sessionId: string, trigger: TurnTrigger) => Promise<string>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The user's controls for a recurring task: approve (with their browser's time zone), decline,
 * disable, run now, and run whatever is due for this session when the page opens.
 */
export function createAutomationHandler(store: Store, generate: Generate | undefined, now: () => Date = () => new Date()) {
  const deps = (): AutomationRunDependencies => ({ store, generate: generate!, now });
  return async (request: Request): Promise<Response> => {
    if (!sameOrigin(request)) return new Response('Unexpected origin', { status: 403 });
    const sessionId = await signedInSession(store, request);
    if (!sessionId) return new Response('Session required', { status: 401 });
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; } catch { return new Response('Invalid JSON', { status: 400 }); }
    const action = body?.action;
    if (action === 'run_due') {
      if (!generate) return Response.json({ status: 'unavailable' }, { status: 503 });
      const due = await store.claimDueAutomations(sessionId, 1);
      const results = [];
      for (const automation of due) results.push(await runAutomation(deps(), automation, 'schedule'));
      return Response.json({ status: 'ok', ran: results.filter((result) => result.status === 'ran').length });
    }
    if (typeof body.id !== 'string' || !UUID.test(body.id)) return new Response('Invalid automation', { status: 400 });
    const automation = await store.getAutomation(sessionId, body.id);
    if (!automation) return new Response('Automation not found', { status: 404 });
    const described = describeSchedule(scheduleOf(automation));
    const at = now().toISOString();
    if (action === 'approve') {
      if (typeof body.timezone !== 'string' || !isValidTimeZone(body.timezone)) return new Response('A valid time zone is required', { status: 400 });
      if (automation.status !== 'proposed') return Response.json({ status: automation.status }, { status: 409 });
      const first = nextRun(scheduleOf(automation), body.timezone, now());
      const result = await store.approveAutomation(sessionId, automation.id, body.timezone, first);
      if (result !== 'approved') return Response.json({ status: result }, { status: 409 });
      await store.appendEvent(sessionId, { id: `automation:${automation.id}:approved`, at, type: 'automation', automationId: automation.id, phase: 'approved', title: automation.title, schedule: described, nextRunAt: first.toISOString() });
      return Response.json({ status: 'approved', nextRunAt: first.toISOString() });
    }
    if (action === 'decline' || action === 'disable') {
      const changed = await store.setAutomationStatus(sessionId, automation.id, action === 'decline' ? 'proposed' : 'active', action === 'decline' ? 'declined' : 'disabled');
      if (!changed) return Response.json({ status: automation.status }, { status: 409 });
      const phase = action === 'decline' ? 'declined' : 'disabled';
      await store.appendEvent(sessionId, { id: `automation:${automation.id}:${phase}`, at, type: 'automation', automationId: automation.id, phase, title: automation.title, schedule: described });
      return Response.json({ status: phase });
    }
    if (action === 'run_now') {
      if (!generate) return Response.json({ status: 'unavailable' }, { status: 503 });
      if (automation.status !== 'active') return Response.json({ status: automation.status }, { status: 409 });
      if (!(await store.consumeQuota(sessionId, 'chat', 12, 60)) || !(await withinIpLimit(store, request, 'follow_up'))) return new Response('Too many requests; try again shortly', { status: 429 });
      return Response.json(await runAutomation(deps(), automation, 'run_now'));
    }
    return new Response('Invalid action', { status: 400 });
  };
}

/** Scheduled entry point for a hosting cron (e.g. Vercel Cron), authorized by CRON_SECRET. */
export function createDueRunner(store: Store, generate: Generate, secret: string | undefined, now: () => Date = () => new Date()) {
  return async (request: Request): Promise<Response> => {
    if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return new Response('Not found', { status: 404 });
    const due = await store.claimDueAutomations(undefined, 5);
    let ran = 0;
    for (const automation of due) {
      try { if ((await runAutomation({ store, generate, now }, automation, 'schedule')).status === 'ran') ran += 1; }
      catch (error) { console.error('Scheduled automation failed', error); }
    }
    return Response.json({ claimed: due.length, ran });
  };
}
