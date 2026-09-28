import type { SessionEvent } from './events';
import { projectSession } from './project';

/**
 * The onboarding funnel, derived from a session's events. Activation is the first approved recurring
 * task: in an earlier product, a scheduled task on day one predicted retention while connecting an
 * account alone did not, so connecting is a step, not the goal.
 */
export const FUNNEL_STAGES = [
  'replied', 'stayed', 'named', 'knowsUser', 'needKnown', 'callOffered', 'callHappened',
  'gmailConnected', 'setupDone', 'firstValue', 'taskProposed', 'activated', 'returned',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const STAGE_LABELS: Record<FunnelStage, string> = {
  replied: 'Replied to the greeting',
  stayed: 'Stayed past the first exchange (3+ turns, or a call)',
  named: 'Named the assistant',
  knowsUser: 'Shared their name (or chose not to)',
  needKnown: 'Said what they need help with',
  callOffered: 'Was offered a call',
  callHappened: 'Talked on a call',
  gmailConnected: 'Connected Gmail',
  setupDone: 'Finished setup (all four known) or chose to skip ahead',
  firstValue: 'Saw something real from their accounts',
  taskProposed: 'Was offered a recurring task',
  activated: 'Approved a recurring task',
  returned: 'Came back later',
};

export function sessionStages(events: SessionEvent[]): Record<FunnelStage, boolean> {
  const state = projectSession(events);
  const spoken = state.calls.reduce((count, call) => count + call.utterances.filter((utterance) => utterance.speaker === 'user').length, 0);
  const userTurns = state.messages.filter((message) => message.speaker === 'user').length + spoken;
  const progress = state.onboarding;
  const callHappened = progress.call === 'happened';
  return {
    replied: userTurns > 0,
    stayed: userTurns >= 3 || callHappened,
    named: progress.assistantName.status === 'confirmed',
    knowsUser: progress.preferredName.status === 'confirmed' || progress.preferredName.status === 'declined',
    needKnown: progress.need.status === 'confirmed' || progress.need.status === 'tentative',
    callOffered: callHappened || progress.call !== 'not_offered',
    callHappened,
    gmailConnected: events.some((event) => event.type === 'connection' && event.toolkit === 'gmail' && event.phase === 'connected'),
    setupDone: state.setup.stage !== 'active',
    firstValue: events.some((event) => (event.type === 'account_read' && event.items > 0) || (event.type === 'automation' && event.phase === 'ran')),
    taskProposed: state.automations.length > 0,
    activated: events.some((event) => event.type === 'automation' && event.phase === 'approved'),
    returned: events.some((event) => event.type === 'visit'),
  };
}

export interface FunnelSummary {
  sessions: number;
  stages: Array<{ stage: FunnelStage; label: string; count: number; percent: number }>;
}

export function summarizeFunnel(sessions: SessionEvent[][]): FunnelSummary {
  const all = sessions.map(sessionStages);
  const percent = (count: number) => (all.length ? Math.round((count / all.length) * 1000) / 10 : 0);
  return {
    sessions: all.length,
    stages: FUNNEL_STAGES.map((stage) => {
      const count = all.filter((stages) => stages[stage]).length;
      return { stage, label: STAGE_LABELS[stage], count, percent: percent(count) };
    }),
  };
}
