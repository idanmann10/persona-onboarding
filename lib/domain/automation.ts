import type { Toolkit } from './events';
import type { Cadence, Schedule } from './schedule';

export type AutomationStatus = 'proposed' | 'active' | 'declined' | 'disabled';

export interface AutomationRecord {
  id: string;
  sessionId: string;
  title: string;
  instruction: string;
  toolkits: Toolkit[];
  cadence: Cadence;
  weekday?: number;
  time: string;
  timezone?: string;
  status: AutomationStatus;
  nextRunAt?: string;
}

export const scheduleOf = (automation: Pick<AutomationRecord, 'cadence' | 'weekday' | 'time'>): Schedule =>
  ({ cadence: automation.cadence, weekday: automation.weekday, time: automation.time });

export interface AutomationStore {
  proposeAutomation(sessionId: string, automation: Omit<AutomationRecord, 'sessionId' | 'status' | 'timezone' | 'nextRunAt'>): Promise<void>;
  getAutomation(sessionId: string, id: string): Promise<AutomationRecord | undefined>;
  /** 'conflict' when another automation is already active for the session. */
  approveAutomation(sessionId: string, id: string, timezone: string, nextRunAt: Date): Promise<'approved' | 'not_found' | 'conflict'>;
  setAutomationStatus(sessionId: string, id: string, from: AutomationStatus, to: 'declined' | 'disabled'): Promise<boolean>;
  /** Atomically claim due active automations (one session, or all when sessionId is undefined). */
  claimDueAutomations(sessionId: string | undefined, limit: number): Promise<AutomationRecord[]>;
  /** False when this occurrence already ran (duplicate trigger, second tab, overlapping cron). */
  startAutomationRun(run: { id: string; automationId: string; sessionId: string; scheduledFor: Date; trigger: 'schedule' | 'run_now' }): Promise<boolean>;
  finishAutomationRun(runId: string, status: 'succeeded' | 'failed', messageEventId?: string, error?: string): Promise<void>;
  /** Set the next occurrence and release the claim. */
  advanceAutomation(id: string, nextRunAt: Date | null): Promise<void>;
}
