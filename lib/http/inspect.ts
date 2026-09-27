import type { SessionEvent } from '../domain/events';
import { projectSession } from '../domain/project';
import { personaSettings } from '../domain/persona';
import type { AutomationRecord } from '../domain/automation';
import { buildAgentLog } from '../observability/log';
import type { StoredTrace } from '../observability/trace';
import { readSessionCookie } from './session';

interface Store {
  sessionExists(id: string): Promise<boolean>;
  readEvents(id: string): Promise<SessionEvent[]>;
  readTraces(id: string): Promise<StoredTrace[]>;
  listAutomations?(id: string): Promise<AutomationRecord[]>;
}

/**
 * GET /api/inspect: the agent log for the caller's own session only (the session cookie), for a
 * reviewer watching the agent work: what it knows, every turn with its steps and tools, and calls.
 */
export function createInspectHandler(store: Store, env: Record<string, string | undefined> = {}) {
  return async (request: Request): Promise<Response> => {
    const sessionId = readSessionCookie(request);
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId) || !(await store.sessionExists(sessionId))) {
      return Response.json({ error: 'Session required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    const [events, traces, automations] = await Promise.all([
      store.readEvents(sessionId), store.readTraces(sessionId), store.listAutomations?.(sessionId) ?? Promise.resolve([]),
    ]);
    const state = projectSession(events);
    const facts = Object.entries(state.facts).map(([key, fact]) => ({ key, value: fact.value, evidence: fact.evidence, provenance: fact.provenance }));
    const log = buildAgentLog(state, events, traces);
    return Response.json({
      state: {
        progress: state.onboarding,
        settings: personaSettings(state, env.OPENAI_VOICE),
        connections: state.connections,
        automations: automations.length
          ? automations.map((item) => ({ id: item.id, title: item.title, status: item.status, cadence: item.cadence, time: item.time, ...(item.nextRunAt ? { nextRunAt: item.nextRunAt } : {}) }))
          : state.automations.map((item) => ({ id: item.automationId, title: item.title, status: item.status, schedule: item.schedule, ...(item.nextRunAt ? { nextRunAt: item.nextRunAt } : {}) })),
        facts,
      },
      ...log,
      generatedAt: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  };
}
