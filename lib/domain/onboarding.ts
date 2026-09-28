import type { OnboardingProgress } from './project';
import type { SetupItem } from './events';

export type { SetupItem };

/**
 * The trial brief's goal, as server state: a session ends setup with four things known (a name for the
 * assistant, what to call the user, what they need, and Gmail) or with the user choosing to skip ahead.
 * What to do next is the onboarding coach's call (lib/agent/subagents/coach.ts), not a fixed order.
 */
export type SetupStage = 'active' | 'complete' | 'graduated';

export interface SetupStatus {
  stage: SetupStage;
  /** What is still unresolved, in the brief's order. The call is a means, not an item. */
  open: Exclude<SetupItem, 'call'>[];
}

export function setupStatus(progress: OnboardingProgress, options: { graduated?: boolean } = {}): SetupStatus {
  const open: SetupStatus['open'] = [
    ...(progress.assistantName.status === 'unknown' ? ['assistant_name' as const] : []),
    ...(progress.preferredName.status === 'unknown' ? ['preferred_name' as const] : []),
    ...(progress.need.status === 'unknown' ? ['need' as const] : []),
    ...(progress.gmail === 'connected' || progress.gmail === 'declined' ? [] : ['gmail' as const]),
  ];
  if (options.graduated) return { stage: 'graduated', open };
  return { stage: open.length ? 'active' : 'complete', open };
}

export const SETUP_LABELS: Record<SetupItem, string> = {
  assistant_name: 'a name for you',
  preferred_name: 'what to call them',
  need: 'what they need help with',
  gmail: 'Gmail',
  call: 'a short call',
};
