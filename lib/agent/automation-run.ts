import type { SessionEvent } from '../domain/events';
import { scheduleOf, type AutomationRecord, type AutomationStore } from '../domain/automation';
import { describeSchedule, nextRun } from '../domain/schedule';
import type { TurnTrigger } from './turn';

export interface AutomationRunDependencies {
  store: Pick<AutomationStore, 'startAutomationRun' | 'finishAutomationRun' | 'advanceAutomation'> & {
    appendEvent(id: string, event: SessionEvent): Promise<void>;
    readEvents(id: string): Promise<SessionEvent[]>;
  };
  generate(history: SessionEvent[], sessionId: string, trigger: TurnTrigger): Promise<string>;
  now?: () => Date;
}

export type AutomationRunResult =
  | { status: 'ran'; message: { id: string; role: 'assistant'; text: string } }
  | { status: 'failed' }
  | { status: 'duplicate' };

/**
 * Run one occurrence of an approved recurring task: the same turn builder and gates as chat, with the
 * task's accounts opened for reading. The run row makes an occurrence execute once however many
 * tabs, crons or clicks ask for it; the message and `ran` event are the proof it happened.
 */
export async function runAutomation(deps: AutomationRunDependencies, automation: AutomationRecord, trigger: 'schedule' | 'run_now'): Promise<AutomationRunResult> {
  const now = deps.now?.() ?? new Date();
  const schedule = scheduleOf(automation);
  const described = describeSchedule(schedule);
  const scheduledFor = trigger === 'schedule' && automation.nextRunAt ? new Date(automation.nextRunAt) : new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const upcoming = trigger === 'schedule' && automation.timezone
    ? nextRun(schedule, automation.timezone, new Date(Math.max(now.getTime(), scheduledFor.getTime())))
    : automation.nextRunAt ? new Date(automation.nextRunAt) : null;
  const release = () => trigger === 'schedule' ? deps.store.advanceAutomation(automation.id, upcoming) : Promise.resolve();
  const runId = crypto.randomUUID();
  if (!(await deps.store.startAutomationRun({ id: runId, automationId: automation.id, sessionId: automation.sessionId, scheduledFor, trigger }))) {
    await release();
    return { status: 'duplicate' };
  }
  const accounts = automation.toolkits.length ? automation.toolkits.map((toolkit) => (toolkit === 'gmail' ? 'Gmail' : 'Google Calendar')).join(' and ') : 'no accounts';
  const triggered: TurnTrigger = {
    id: `automation:${automation.id}:${scheduledFor.toISOString()}:${trigger}`,
    include: automation.toolkits,
    instruction: [
      `It is time for the user's approved recurring task "${automation.title}" (${described}${trigger === 'run_now' ? ', run now at their request' : ''}).`,
      `Do exactly this now: ${automation.instruction}`,
      `Use only ${accounts}, read-only. If an account is not connected or a read fails, say so plainly in one line and suggest reconnecting.`,
      'Report the result in one short message that leads with what you found. Never claim an action you did not take, and do not ask onboarding questions in this message.',
    ].join('\n'),
  };
  const at = () => (deps.now?.() ?? new Date()).toISOString();
  let text: string;
  try {
    text = (await deps.generate(await deps.store.readEvents(automation.sessionId), automation.sessionId, triggered)).trim();
  } catch (error) {
    await deps.store.finishAutomationRun(runId, 'failed', undefined, error instanceof Error ? error.message : 'Run failed');
    await deps.store.appendEvent(automation.sessionId, { id: `automation:${automation.id}:failed:${runId}`, at: at(), type: 'automation', automationId: automation.id, phase: 'failed', title: automation.title, schedule: described, runId });
    await release();
    return { status: 'failed' };
  }
  const message = { id: `answer:${triggered.id}`, role: 'assistant' as const, text: text || `Nothing new for "${automation.title}" this time.` };
  await deps.store.appendEvent(automation.sessionId, { id: message.id, at: at(), type: 'message', speaker: 'assistant', channel: 'text', text: message.text, origin: 'automation' });
  await deps.store.appendEvent(automation.sessionId, {
    id: `automation:${automation.id}:ran:${runId}`, at: at(), type: 'automation', automationId: automation.id, phase: 'ran', title: automation.title, schedule: described, runId,
    ...(upcoming ? { nextRunAt: upcoming.toISOString() } : {}),
  });
  await deps.store.finishAutomationRun(runId, 'succeeded', message.id);
  await release();
  return { status: 'ran', message };
}
