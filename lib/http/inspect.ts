import type { SessionEvent } from '../domain/events';
import { projectSession } from '../domain/project';
import { personaSettings } from '../domain/persona';
import type { AutomationRecord } from '../domain/automation';
import { buildAgentLog } from '../observability/log';
import { buildUserState } from '../domain/user-state';
import type { StoredTrace } from '../observability/trace';
import { signedInSession, type LoginStore } from '../auth/login';

interface Store extends LoginStore {
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
    const sessionId = await signedInSession(store, request);
    if (!sessionId) {
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
        // The labeled state the agents read, and what each agent added to its own soul for this user.
        user: (() => {
          const user = buildUserState(state, new Date(), env.OPENAI_VOICE);
          const count = (status: string) => state.memory.memories.filter((memory) => memory.status === status).length;
          return {
            lifecycle: user.lifecycle, setup: user.setup, labels: user.labels, openLoops: user.openLoops, checkIn: user.checkIn ?? null,
            profile: user.profile, memories: user.memories, memoryCounts: { live: user.memories.length, replaced: count('replaced'), forgotten: count('forgotten') },
            ...(state.memory.summary ? { summary: { text: state.memory.summary.text, lines: state.memory.summary.lines } } : {}),
          };
        })(),
        soulNotes: Object.fromEntries(Object.entries(state.memory.soulNotes).map(([agent, notes]) => [agent, notes.map((note) => note.text)])),
      },
      ...log,
      generatedAt: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  };
}
