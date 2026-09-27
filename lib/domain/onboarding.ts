import type { OnboardingProgress } from './project';

/**
 * The trial brief's goal, as server state: a session ends with the four things known — a name for the
 * assistant, what to call the user, what they need, and Gmail — or with the user choosing to skip ahead.
 * The call is how the rest gets collected, so it is the next move after the name while anything is open.
 */
export type SetupItem = 'assistant_name' | 'call' | 'preferred_name' | 'need' | 'gmail';
export type SetupStage = 'active' | 'complete' | 'graduated';

export interface SetupStatus {
  stage: SetupStage;
  /** What is still unresolved, in the brief's order. */
  open: SetupItem[];
  /** The one thing to go for next; undefined when the only open item is already on screen (an Answer or Connect card). */
  next?: SetupItem;
}

export function setupStatus(progress: OnboardingProgress, options: { graduated?: boolean; voice?: boolean } = {}): SetupStatus {
  const named = progress.assistantName.status !== 'unknown';
  const knowsUser = progress.preferredName.status !== 'unknown';
  const needKnown = progress.need.status !== 'unknown';
  const gmailDone = progress.gmail === 'connected' || progress.gmail === 'declined';
  const open: SetupItem[] = [
    ...(named ? [] : ['assistant_name' as const]),
    ...(knowsUser ? [] : ['preferred_name' as const]),
    ...(needKnown ? [] : ['need' as const]),
    ...(gmailDone ? [] : ['gmail' as const]),
  ];
  if (options.graduated) return { stage: 'graduated', open };
  if (!open.length) return { stage: 'complete', open };
  const callWorthOffering = options.voice !== false && progress.call === 'not_offered' && named && (!knowsUser || !needKnown || !gmailDone);
  const next: SetupItem | undefined = !named ? 'assistant_name'
    : callWorthOffering ? 'call'
      : !knowsUser ? 'preferred_name'
        : !needKnown ? 'need'
          : progress.gmail === 'not_offered' || progress.gmail === 'failed' ? 'gmail'
            : undefined;
  return { stage: 'active', open: callWorthOffering ? ['call', ...open] : open, next };
}

export const SETUP_LABELS: Record<SetupItem, string> = {
  assistant_name: 'a name for you',
  call: 'the call',
  preferred_name: 'what to call them',
  need: 'what they need help with',
  gmail: 'Gmail',
};
