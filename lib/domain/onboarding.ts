import type { OnboardingProgress } from './project';
import type { SessionEvent } from './events';

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
  /** Open items that can be asked for now, in order (not the ones whose card is already on screen). */
  askable?: SetupItem[];
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
  const askable = [
    ...(named ? [] : ['assistant_name' as const]),
    ...(callWorthOffering ? ['call' as const] : []),
    ...(knowsUser ? [] : ['preferred_name' as const]),
    ...(needKnown ? [] : ['need' as const]),
    ...(progress.gmail === 'not_offered' || progress.gmail === 'failed' ? ['gmail' as const] : []),
  ];
  return { stage: 'active', open: callWorthOffering ? ['call', ...open] : open, next, askable };
}

export const SETUP_LABELS: Record<SetupItem, string> = {
  assistant_name: 'a name for you',
  call: 'the call',
  preferred_name: 'what to call them',
  need: 'what they need help with',
  gmail: 'Gmail',
};

const SETUP_FACTS = new Set(['assistant_name', 'preferred_name', 'current_need']);

/** An event that moves setup forward: an item saved or declined, the Gmail card shown or answered, the call offered or taken. */
function movesSetup(event: SessionEvent): boolean {
  if (event.type === 'fact') return SETUP_FACTS.has(event.key);
  if (event.type === 'connection') return event.toolkit === 'gmail' && event.phase !== 'disconnected';
  if (event.type === 'call') return event.phase !== 'ended' && event.phase !== 'dropped';
  return event.type === 'onboarding';
}

/**
 * The user's messages since setup last moved forward. Helping with a task is right, but without this the
 * assistant helps and never comes back (live simulation: the user's name was never asked in 8 of 11
 * sessions that missed the goal). The prompt turns this into one short ask, then an explicit
 * finish-or-skip choice, and then stops asking.
 */
export function repliesSinceSetupMoved(events: SessionEvent[]): number {
  let since = 0;
  for (const event of events) {
    if (movesSetup(event)) since = 0;
    // Count the user's messages: an exchange that went by without progress. The reply in the turn that made
    // progress lands after its fact, so counting replies would count that turn as stalled.
    else if (event.type === 'message' && event.speaker === 'user') since++;
  }
  return since;
}
