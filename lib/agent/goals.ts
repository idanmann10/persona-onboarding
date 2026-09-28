import { SETUP_LABELS } from '../domain/onboarding';
import type { UserState } from '../domain/user-state';

/**
 * The onboarding goals still open, in order, and the one to aim at now: read from state, for the chat and
 * the call alike. It's the model's target, not a script: the words, and whether their task comes first,
 * stay the model's call. Nothing once they're settled in.
 */
export function onboardingGoals(user: UserState, options: { channel: 'text' | 'voice'; voice?: boolean }): { steps: string[]; target?: string; ask?: string } {
  if (user.lifecycle.stage !== 'onboarding') return { steps: [] };
  const steps: string[] = [];
  // Beside each goal, the short spoken ask a call opens with when it's the aim (the call's hello asks it).
  const asks: string[] = [];
  const add = (step: string, ask: string) => { steps.push(step); asks.push(ask); };
  const setupOpen = !user.lifecycle.skippedSetup;
  const open = (item: keyof UserState['setup']) => user.setup[item].status === 'unknown' || user.setup[item].status === 'asked';
  // Skipping setup ends the questions, not the steering toward value.
  if (setupOpen) {
    if (options.channel === 'text' && open('assistant_name')) add('a name for you: they pick it (if they asked you to choose, pick one yourself with customize)', 'what should I go by?');
    const basics = (['preferred_name', 'need', 'gmail'] as const).filter(open);
    // The call covers the rest fastest, once there's a name and something left to cover.
    if (options.channel === 'text' && options.voice && !open('assistant_name') && user.setup.call.status === 'unknown' && basics.length) {
      add('offer the short call with offer_call (the Answer button); talking covers the rest fastest', '');
    }
    for (const item of basics) {
      if (item === 'preferred_name') {
        if (user.identity.callThem && !user.identity.callThem.confirmed) add(`check that "${user.identity.callThem.name}" is what they like to be called`, `quick one, is ${user.identity.callThem.name} what you like to go by?`);
        else add(SETUP_LABELS[item], 'what should I call you?');
      } else if (item === 'need') add("what they'd most like off their plate (a task or a pain, not who they are)", "what's eating most of your time right now?");
      else add('Gmail (show_connection), tied to what they need, so you can show them something real', 'want to hook up Gmail so I can show you who is waiting on you?');
    }
  }
  const gmail = user.accounts.gmail === 'connected';
  if (!user.activation.firstValueAt) {
    asks.push(gmail ? 'want me to check who is waiting on you in your inbox?' : "what's the one thing you'd love off your plate this week?");
    steps.push(gmail
      ? 'the first win: look in their inbox (or calendar) for what they need and tell them one specific thing, like who is waiting on them'
      : user.setup.gmail.status === 'declined'
        ? 'the first win: help with what they tell you right now, something real and specific'
        : "the first win: when their need touches email, put the Connect Gmail button up (show_connection), then read their inbox once they're in");
  }
  const task = user.activation.recurring;
  if (task.status === 'proposed') add('their first recurring task: the preview card is waiting, so point them to Approve', 'the rundown card is waiting in the chat, want it every morning?');
  else if (task.status === 'none') add('their first recurring task: offer to make the win happen on its own with propose_automation (e.g. a weekday-morning rundown of who is waiting on them)', 'want me to send you a morning rundown like that on its own?');
  // The call's opening ask: the first goal that can be asked out loud (not the call offer itself).
  return { steps, target: steps[0], ask: asks.find(Boolean) };
}
