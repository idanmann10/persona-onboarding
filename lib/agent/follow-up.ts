import type { Toolkit } from '../domain/events';
import type { SessionProjection } from '../domain/project';
import { callDuration, END_REASONS, type TurnTrigger } from './turn';

export type FollowUpRequest = { kind: 'call_ended'; callId: string } | { kind: 'connection'; toolkit: Toolkit };

export const SILENT = '<silent>';

const DROPPED = new Set(['connection_lost', 'lost']);
const TOOLKIT_NAMES: Record<Toolkit, string> = { gmail: 'Gmail', calendar: 'Google Calendar' };

/**
 * Turn an app event into a trigger for one assistant turn, using only server state. Returns undefined
 * when the event has not happened (a call still live, an account not actually connected).
 */
export function describeTrigger(state: SessionProjection, request: FollowUpRequest): TurnTrigger | undefined {
  if (request.kind === 'call_ended') {
    const call = state.calls.find((record) => record.callId === request.callId);
    if (!call || (call.phase !== 'ended' && call.phase !== 'dropped')) return undefined;
    const reason = call.reason ?? (call.phase === 'dropped' ? 'connection_lost' : 'remote_hangup');
    if (reason === 'setup_failed' || (!call.startedAt && !call.utterances.length)) {
      return {
        id: `followup:call:${call.callId}`,
        instruction: 'Something just happened: a call the user started never connected. In one short line, say the call didn\'t go through and offer to keep going here or try again. Do not guess why.',
      };
    }
    const last = call.utterances.at(-1);
    const cutOff = last?.speaker === 'user' && !/[.?!…"')\]]$/.test(last.text);
    const duration = callDuration(call.startedAt, call.endedAt);
    const lines = [
      `Something just happened: the browser call ended because ${END_REASONS[reason]}${duration ? `, after ${duration}` : ''}.`,
      cutOff ? 'Their last line in the call transcript above may have been cut off mid-sentence.' : '',
      'Decide what a thoughtful person would do next, then either send one short text or stay silent.',
      '- First, save anything they told you on the call that is not saved yet (a name for you, their name, what they need).',
      '- If something was left unfinished (they hung up or the line dropped mid-thought), send one short message that picks up right where you left off and names what they were talking about. Do not invent what they were about to say.',
      DROPPED.has(reason) ? '- The line dropped, so you may offer to call back or to keep going here.' : '',
      reason === 'user_hangup' || reason === 'page_closed' ? '- They ended the call themselves, so don\'t push another call.' : '',
      reason === 'inactive' ? '- The call went quiet; check in gently here without pressure.' : '',
      `- If the call wrapped up naturally and nothing is open, reply with exactly ${SILENT}. Send a short recap only if you promised them something.`,
      "- If it ended without a goodbye (a hang-up, a drop or a quiet line) before you learned what they'd like help with, send one short line that picks it up here.",
      '- Mention saved names, connected accounts or completed work only if the app state above confirms them.',
    ];
    return { id: `followup:call:${call.callId}`, instruction: lines.filter(Boolean).join('\n') };
  }
  const phase = state.connections[request.toolkit];
  const notice = [...state.timeline].reverse().find((item) => item.kind === 'connection_notice' && item.toolkit === request.toolkit);
  if (!notice || (phase !== 'connected' && phase !== 'failed')) return undefined;
  const name = TOOLKIT_NAMES[request.toolkit];
  if (phase === 'failed') {
    return {
      id: `followup:${notice.id}`,
      instruction: `Something just happened: connecting ${name} did not finish (Google's sign-in was cancelled or failed). In one short line, say so without blame and offer to try again or to keep going without it.`,
    };
  }
  return {
    id: `followup:${notice.id}`,
    include: [request.toolkit],
    instruction: [
      `Something just happened: the user connected ${name} a moment ago, and the app confirmed it.`,
      request.toolkit === 'gmail'
        ? '- If what they want help with involves email, search their inbox now and tell them one or two specific things you found (for example, who is waiting on a reply), then offer one next step. If what you found is useful, offer in the same message to send them a rundown like this on a schedule, with the preview card (propose_automation).'
        : '- If what they want help with involves their schedule, read the relevant days now and tell them one or two specific things you found, then offer one next step.',
      '- If there is no clear need yet, confirm it is connected in a few words and suggest one useful thing you could do with it.',
      '- Keep it short and don\'t ask them to repeat anything.',
    ].join('\n'),
  };
}

export function isSilent(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed || trimmed.toLowerCase().startsWith(SILENT);
}
