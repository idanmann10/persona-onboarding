import type { CallEndReason, Toolkit } from '../../lib/domain/events';
import type { CallRecord, SessionProjection, TimelineItem } from '../../lib/domain/project';
import type { SimControl } from './user';

const TOOLKIT_NAMES: Record<Toolkit, string> = { gmail: 'Gmail', calendar: 'Google Calendar' };
const CONNECT: Record<Toolkit, SimControl> = { gmail: 'connect_gmail', calendar: 'connect_calendar' };
const NOT_NOW: Record<Toolkit, SimControl> = { gmail: 'not_now_gmail', calendar: 'not_now_calendar' };

/** How the thread labels a finished call (mirrors app/thread.tsx). */
const ENDINGS: Record<CallEndReason, string> = {
  user_hangup: 'You hung up',
  remote_hangup: 'Call ended',
  expired: 'Call ended',
  connection_lost: 'Call dropped',
  lost: 'Call dropped',
  page_closed: 'Page closed',
  inactive: 'Ended after a quiet line',
  max_duration: 'Reached the time limit',
  content: 'Call stopped',
  setup_failed: "Couldn't connect",
};

/** The name the app shows for the assistant (mirrors app/page.tsx). */
export function assistantName(state: SessionProjection): string {
  const slot = state.onboarding.assistantName;
  return (slot.status === 'confirmed' || slot.status === 'tentative') && slot.value ? slot.value : 'Persona';
}

/**
 * The buttons a person can tap right now. The call offer's buttons are disabled during a call, as in
 * the app; Connect and recurring-task buttons stay usable.
 */
export function pendingControls(state: SessionProjection, options: { onCall?: boolean } = {}): SimControl[] {
  const controls: SimControl[] = [];
  const add = (...items: SimControl[]) => { for (const item of items) if (!controls.includes(item)) controls.push(item); };
  for (const item of state.timeline) {
    if (item.kind === 'call_offer' && item.status === 'pending' && !options.onCall) add('answer_call', 'not_now_call');
    else if (item.kind === 'connection_offer' && (item.status === 'pending' || item.status === 'failed')) add(CONNECT[item.toolkit], NOT_NOW[item.toolkit]);
    else if (item.kind === 'automation' && item.status === 'proposed') add('approve_task', 'not_now_task');
  }
  return controls;
}

function duration(call: CallRecord): string {
  if (!call.startedAt || !call.endedAt) return '';
  const seconds = Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A message body; continuation lines are indented under the speaker. */
const body = (text: string) => text.trim().replace(/\n{3,}/g, '\n\n').split('\n')
  .map((line, index) => (index === 0 || !line.trim() ? line.trim() : `  ${line.trim()}`)).join('\n');
const speakerLabel = (speaker: 'user' | 'assistant', name: string) => (speaker === 'user' ? 'You' : name);

function renderCall(call: CallRecord, name: string): string {
  const ended = call.phase === 'ended' || call.phase === 'dropped';
  const label = ended ? ENDINGS[call.reason ?? (call.phase === 'dropped' ? 'connection_lost' : 'remote_hangup')] : 'Call';
  const header = `[Call with ${name}${duration(call) ? ` · ${duration(call)}` : ''} · ${label}]`;
  return [header, ...call.utterances.map((utterance) => `  ${speakerLabel(utterance.speaker, name)}: ${utterance.text}`)].join('\n');
}

function renderItem(item: TimelineItem, name: string, liveCallId?: string): string | undefined {
  switch (item.kind) {
    case 'message':
      return `${speakerLabel(item.speaker, name)}${item.origin === 'automation' ? ' (recurring task)' : ''}: ${body(item.text)}`;
    case 'call':
      return item.call.callId === liveCallId ? undefined : renderCall(item.call, name);
    case 'call_offer':
      if (item.status === 'answered') return undefined;
      if (item.status === 'declined') return '(Call declined)';
      return `[Card] ${name} is ready to call — A short call in your browser. Answering asks for your microphone. — buttons: Answer (answer_call) / Not now (not_now_call)`;
    case 'connection_offer': {
      const toolkit = TOOLKIT_NAMES[item.toolkit];
      if (item.status === 'connected') return undefined;
      if (item.status === 'declined') return `(Skipped ${toolkit} for now)`;
      const connect = item.status === 'failed' ? 'Try again' : `Connect ${toolkit}`;
      return `[Card] Connect ${toolkit} — ${item.reason || `So ${name} can help with this.`} Read-only, and you can disconnect anytime. — buttons: ${connect} (${CONNECT[item.toolkit]}) / Not now (${NOT_NOW[item.toolkit]})`;
    }
    case 'connection_notice': {
      const toolkit = TOOLKIT_NAMES[item.toolkit];
      return `(${item.phase === 'connected' ? `${toolkit} connected` : item.phase === 'failed' ? `${toolkit} didn't connect` : `${toolkit} disconnected`})`;
    }
    case 'automation': {
      if (item.status === 'declined') return `(Skipped "${item.title}")`;
      if (item.status === 'disabled') return `(Turned off "${item.title}")`;
      if (item.status === 'active') return `(Recurring task on: "${item.title}", ${item.schedule})`;
      const schedule = item.schedule.charAt(0).toUpperCase() + item.schedule.slice(1);
      return `[Card] Recurring task preview: "${item.title}", ${schedule} in your time zone${item.instruction ? ` — ${item.instruction}` : ''} — buttons: Approve (approve_task) / Not now (not_now_task)`;
    }
    case 'automation_notice':
      return `("${item.title}" couldn't run this time)`;
  }
}

/**
 * The chat screen as plain text: messages, finished calls with their transcripts, pending cards with
 * the controls to tap, and short status lines for resolved cards. No tool calls or system text: the
 * person sees only what the app shows. A live call is left out here; see renderCallScreen.
 */
export function renderScreen(state: SessionProjection, options: { liveCallId?: string } = {}): string {
  const name = assistantName(state);
  const lines = [
    name === 'Persona' ? 'Persona app. Chat with Persona, your new assistant.' : `Persona app. Chat with ${name}, your Persona assistant.`,
    '',
    ...state.timeline.map((item) => renderItem(item, name, options.liveCallId)).filter((line): line is string => Boolean(line)),
  ];
  if (!options.liveCallId) {
    const controls = pendingControls(state);
    lines.push('', controls.length ? `Buttons you can tap: ${controls.join(', ')}` : 'No buttons to tap right now.');
  }
  return lines.join('\n');
}

/** The screen during a live call: the chat so far, then the call transcript as it happens. */
export function renderCallScreen(state: SessionProjection, callId: string): string {
  const name = assistantName(state);
  const call = state.calls.find((record) => record.callId === callId);
  const lines = [renderScreen(state, { liveCallId: callId }), '', `--- Live call with ${name} ---`];
  if (call?.utterances.length) for (const utterance of call.utterances) lines.push(`${speakerLabel(utterance.speaker, name)}: ${utterance.text}`);
  else lines.push('(Nobody has said anything yet.)');
  const controls = pendingControls(state, { onCall: true });
  if (controls.length) lines.push('', `Buttons you can still tap on screen: ${controls.join(', ')}`);
  lines.push('', '(You are on a call. Speak, or hang up.)');
  return lines.join('\n');
}
