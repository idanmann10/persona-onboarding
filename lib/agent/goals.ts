import { SETUP_LABELS } from '../domain/onboarding';
import type { UserState } from '../domain/user-state';

/**
 * The onboarding goals still open, in order, and the one to aim at now: read from state, for the chat and
 * the call alike. It's the model's target, not a script: the words, and whether their task comes first,
 * stay the model's call. Nothing once they're settled in.
 */
export function onboardingGoals(user: UserState, options: { channel: 'text' | 'voice'; voice?: boolean }): { steps: string[]; target?: string } {
  if (user.lifecycle.stage !== 'onboarding') return { steps: [] };
  const setupOpen = !user.lifecycle.skippedSetup;
  const open = (item: keyof UserState['setup']) => user.setup[item].status === 'unknown' || user.setup[item].status === 'asked';
  const steps: string[] = [];
  // Skipping setup ends the questions, not the steering toward value.
  if (setupOpen) {
    if (options.channel === 'text' && open('assistant_name')) steps.push('a name for you: they pick it (if they asked you to choose, pick one yourself with customize)');
    const basics = (['preferred_name', 'need', 'gmail'] as const).filter(open);
    // The call covers the rest fastest, once there's a name and something left to cover.
    if (options.channel === 'text' && options.voice && !open('assistant_name') && user.setup.call.status === 'unknown' && basics.length) {
      steps.push('offer the short call with offer_call (the Answer button); talking covers the rest fastest');
    }
    for (const item of basics) {
      steps.push(item === 'preferred_name' && user.identity.callThem && !user.identity.callThem.confirmed
        ? `check that "${user.identity.callThem.name}" is what they like to be called`
        : item === 'need' ? "what they'd most like off their plate (a task or a pain, not who they are)"
          : item === 'gmail' ? 'Gmail (show_connection), tied to what they need, so you can show them something real'
            : SETUP_LABELS[item]);
    }
  }
  const gmail = user.accounts.gmail === 'connected';
  if (!user.activation.firstValueAt) {
    steps.push(gmail
      ? 'the first win: look in their inbox (or calendar) for what they need and tell them one specific thing, like who is waiting on them'
      : user.setup.gmail.status === 'declined'
        ? 'the first win: help with what they tell you right now, something real and specific'
        : "the first win: when their need touches email, put the Connect Gmail button up (show_connection), then read their inbox once they're in");
  }
  const task = user.activation.recurring;
  if (task.status === 'proposed') steps.push('their first recurring task: the preview card is waiting, so point them to Approve');
  else if (task.status === 'none') steps.push('their first recurring task: offer to make the win happen on its own with propose_automation (e.g. a weekday-morning rundown of who is waiting on them)');
  return { steps, target: steps[0] };
}
