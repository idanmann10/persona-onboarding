import type { CallEndReason, SetupItem } from './events';
import { SETUP_ITEMS } from './events';
import type { CallRecord, SessionProjection } from './project';
import { personaSettings, personalityLine } from './persona';
import { LOOP_LIMITS, NOTE_LIMITS } from './memory';
import { isValidTimeZone } from './schedule';

/**
 * Everything the agents know about the user, labeled, from the event log. The assistant's prompt, the
 * voice prompt and the memory all read this one shape, so they never disagree about the facts.
 */

/** Written by the Google sign-in (exactly these keys). Names are a good guess until the user confirms what to call them. */
export const IDENTITY_KEYS = ['user_email', 'user_full_name', 'user_given_name', 'user_picture', 'user_locale', 'location_city', 'location_region', 'location_country', 'timezone'] as const;

export type Lifecycle = 'onboarding' | 'active';
/** Onboarding ends at activation (the first approved recurring task) or this many days after the first visit. */
export const ONBOARDING_DAYS = 7;
const DAY_MS = 86_400_000;

export interface SetupItemState {
  status: 'unknown' | 'asked' | 'answered' | 'declined';
  asks: number;
  lastAskedAt?: string;
  value?: string;
  /** Anything else worth knowing: a Google name not yet confirmed, a failed connection, a card on screen. */
  note?: string;
}

export interface UserState {
  now: { iso: string; local: string; timezone?: string; hour: number };
  identity: {
    email?: string; fullName?: string; givenName?: string; locale?: string; hasPicture: boolean;
    location?: string; timezone?: string;
    /** What to call them: their own words if they said it, else the Google given name, marked unconfirmed. */
    callThem?: { name: string; confirmed: boolean };
  };
  assistant: { name?: string; personality: string; voice: string; look: string };
  lifecycle: { stage: Lifecycle; day: number; firstSeenAt?: string; skippedSetup: boolean };
  setup: Record<SetupItem, SetupItemState>;
  needs: string[];
  openLoops: Array<{ id: string; text: string; at: string }>;
  accounts: { gmail: string; calendar: string; apps: string[]; reads: Array<{ toolkit: string; items: number; at: string }> };
  calls: Array<{ at?: string; duration?: string; ended: string; cutOff?: string }>;
  engagement: { lastSeenAt?: string; visits: number; userMessages: number; unpromptedLast24h: number; lastUnpromptedAt?: string };
  activation: {
    activated: boolean; firstValueAt?: string;
    recurring: { status: string; title?: string; schedule?: string; lastRun?: 'ran' | 'failed'; lastRunAt?: string };
  };
  labels: Array<{ label: string; confidence: string; evidence: string }>;
  notes: Array<{ text: string; kind: string; source: string }>;
  summary?: string;
  /** A check-in the assistant scheduled, still ahead and not cancelled by a reply. */
  checkIn?: { wakeAt: string; reason: string };
}

export const END_REASONS: Record<CallEndReason, string> = {
  user_hangup: 'they hung up',
  remote_hangup: 'the call was hung up',
  connection_lost: 'the connection dropped',
  page_closed: 'they closed or left the page',
  lost: 'the call was lost without a goodbye (the page closed or the network went away)',
  inactive: 'it went quiet, so the call was closed',
  max_duration: 'it reached the time limit',
  expired: 'it reached the session time limit',
  content: 'a safety filter stopped it',
  setup_failed: 'it never connected',
  goodbye: 'you said goodbye and hung up',
};

export function callDuration(startedAt?: string, endedAt?: string): string | undefined {
  if (!startedAt || !endedAt) return undefined;
  const seconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)} min ${seconds % 60}s`;
}

export const ABRUPT = new Set<CallEndReason>(['user_hangup', 'connection_lost', 'lost', 'page_closed', 'inactive', 'max_duration', 'expired']);

export function endReason(call: CallRecord): CallEndReason {
  return call.reason ?? (call.phase === 'dropped' ? 'connection_lost' : 'remote_hangup');
}

/** The user's last line on a call that ended abruptly, when it reads unfinished. */
export function cutOffLine(call: CallRecord): string | undefined {
  if (call.phase !== 'ended' && call.phase !== 'dropped') return undefined;
  const last = call.utterances.at(-1);
  if (!last || last.speaker !== 'user' || !ABRUPT.has(endReason(call))) return undefined;
  return /[.?!…"')\]]$/.test(last.text.trim()) ? undefined : last.text.trim().slice(-200);
}

/** The user's zone: the Google sign-in's, or the browser's; UTC when neither is known. */
export function userTimeZone(state: SessionProjection): string | undefined {
  const zone = state.facts.timezone?.value;
  return zone && isValidTimeZone(zone) ? zone : undefined;
}

export function localClock(now: Date, timeZone = 'UTC'): { local: string; hour: number } {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const local = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(now)) % 24;
  return { local, hour };
}

/** Activated = a recurring task was approved at least once (a disabled one was active before). */
export const isActivated = (state: SessionProjection) => state.automations.some((item) => item.status === 'active' || item.status === 'disabled');

export function lifecycleOf(state: SessionProjection, now: Date): UserState['lifecycle'] {
  const activated = isActivated(state);
  const firstSeenAt = state.activity.firstAt;
  const day = firstSeenAt ? Math.floor((now.getTime() - Date.parse(firstSeenAt)) / DAY_MS) + 1 : 1;
  return { stage: activated || day > ONBOARDING_DAYS ? 'active' : 'onboarding', day, ...(firstSeenAt ? { firstSeenAt } : {}), skippedSetup: state.setup.stage === 'graduated' };
}

function setupItems(state: SessionProjection): Record<SetupItem, SetupItemState> {
  const progress = state.onboarding;
  const asks: Record<SetupItem, string[]> = { assistant_name: [], preferred_name: [], need: [], gmail: [], call: [] };
  // The first message asks for a name; a card on screen is an ask.
  const greeting = state.messages.find((message) => message.origin === 'greeting');
  if (greeting) asks.assistant_name.push(greeting.at);
  for (const item of state.timeline) {
    if (item.kind === 'call_offer') asks.call.push(state.messages.find((message) => message.id === `answer:${item.id.replace(/^call-offer:/, '')}`)?.at ?? '');
    if (item.kind === 'connection_offer' && item.toolkit === 'gmail') asks.gmail.push('');
  }
  const slot = (value: { status: string; value?: string }): Pick<SetupItemState, 'status' | 'value'> =>
    value.status === 'declined' ? { status: 'declined' } : value.status === 'unknown' ? { status: 'unknown' } : { status: 'answered', value: value.value };
  const call: SetupItemState['status'] = progress.call === 'happened' ? 'answered' : progress.call === 'declined' ? 'declined' : 'unknown';
  const gmail: SetupItemState['status'] = progress.gmail === 'connected' ? 'answered' : progress.gmail === 'declined' ? 'declined' : 'unknown';
  const base: Record<SetupItem, Pick<SetupItemState, 'status' | 'value' | 'note'>> = {
    assistant_name: slot(progress.assistantName),
    preferred_name: slot(progress.preferredName),
    need: slot(progress.need),
    gmail: { status: gmail, ...(progress.gmail === 'offered' ? { note: 'a Connect Gmail card is on screen' } : progress.gmail === 'failed' ? { note: 'the last connection attempt failed' } : {}) },
    call: { status: call, ...(state.call.offerPending ? { note: 'an Answer card is on screen' } : {}) },
  };
  if (base.preferred_name.status === 'unknown' && state.facts.user_given_name?.value) base.preferred_name.note = `their Google account says "${state.facts.user_given_name.value}"; not confirmed as what they want to be called`;
  const result = {} as Record<SetupItem, SetupItemState>;
  for (const item of SETUP_ITEMS) {
    const times = asks[item];
    const dated = times.filter(Boolean).sort();
    const status = base[item].status === 'unknown' && times.length ? 'asked' : base[item].status;
    result[item] = { ...base[item], status, asks: times.length, ...(dated.length ? { lastAskedAt: dated.at(-1) } : {}) };
  }
  return result;
}

const factValue = (state: SessionProjection, key: string) => state.facts[key]?.value?.trim() || undefined;

export function buildUserState(state: SessionProjection, now: Date, defaultVoice?: string): UserState {
  const timezone = userTimeZone(state);
  const clock = localClock(now, timezone);
  const settings = personaSettings(state, defaultVoice);
  const preferred = state.onboarding.preferredName;
  const given = factValue(state, 'user_given_name');
  const callThem = preferred.value && (preferred.status === 'confirmed' || preferred.status === 'tentative')
    ? { name: preferred.value, confirmed: preferred.status === 'confirmed' }
    : given && preferred.status !== 'declined' ? { name: given, confirmed: false } : undefined;
  const location = [factValue(state, 'location_city'), factValue(state, 'location_region'), factValue(state, 'location_country')].filter(Boolean).join(', ');

  const userMessages = state.messages.filter((message) => message.speaker === 'user');
  const spokeOn = state.calls.filter((call) => call.utterances.some((utterance) => utterance.speaker === 'user')).map((call) => call.lastActivityAt ?? call.endedAt ?? '');
  const lastSeenAt = [...userMessages.map((message) => message.at), ...spokeOn, ...state.activity.visits].filter(Boolean).sort().at(-1);
  const unprompted = state.messages.filter((message) => message.origin === 'follow_up');
  const recentUnprompted = unprompted.filter((message) => now.getTime() - Date.parse(message.at) < DAY_MS);

  const reads = state.activity.reads.map((read) => ({ toolkit: read.toolkit, items: read.items, at: read.at }));
  const latestTask = state.automations.find((item) => item.status === 'active') ?? state.automations.at(-1);
  const lastRun = state.activity.runs.at(-1);
  const firstValueAt = [reads.find((read) => read.items > 0)?.at, state.activity.runs.find((run) => run.phase === 'ran')?.at].filter(Boolean).sort()[0];

  const cutOffs = state.calls.map((call) => ({ call, line: cutOffLine(call) })).filter((entry) => entry.line);
  const lastUserTextAt = userMessages.at(-1)?.at ?? '';
  const loops = [
    ...state.memory.loops.filter((loop) => loop.open).map((loop) => ({ id: loop.loopId, text: loop.text, at: loop.at })),
    // A thought cut off by a hang-up stays open until they write again.
    ...cutOffs.filter(({ call }) => (call.endedAt ?? '') > lastUserTextAt).map(({ call, line }) => ({ id: `cut:${call.callId}`, text: `their last line on the call was cut off: "${line}"`, at: call.endedAt ?? '' })),
  ].slice(-LOOP_LIMITS.open);

  const lastUserAt = userMessages.at(-1)?.at ?? '';
  const pendingCheckIn = state.memory.checkIns.at(-1);
  const checkIn = pendingCheckIn && pendingCheckIn.at > lastUserAt && pendingCheckIn.wakeAt > now.toISOString() ? pendingCheckIn : undefined;
  const needs = [
    ...(state.onboarding.need.value ? [state.onboarding.need.value] : []),
    ...state.memory.notes.filter((note) => note.kind === 'need').map((note) => note.text),
  ].slice(-5);

  return {
    now: { iso: now.toISOString(), local: clock.local, ...(timezone ? { timezone } : {}), hour: clock.hour },
    identity: {
      email: factValue(state, 'user_email'), fullName: factValue(state, 'user_full_name'), givenName: given, locale: factValue(state, 'user_locale'),
      hasPicture: Boolean(factValue(state, 'user_picture')), ...(location ? { location } : {}), ...(timezone ? { timezone } : {}),
      ...(callThem ? { callThem } : {}),
    },
    assistant: { ...(settings.assistantName ? { name: settings.assistantName } : {}), personality: personalityLine(settings), voice: settings.voice, look: settings.avatar },
    lifecycle: lifecycleOf(state, now),
    setup: setupItems(state),
    needs,
    openLoops: loops,
    accounts: {
      gmail: state.connections.gmail, calendar: state.connections.calendar,
      apps: Object.values(state.apps).filter((app) => app.phase === 'connected').map((app) => app.name),
      reads: reads.slice(-5),
    },
    calls: state.calls.filter((call) => call.startedAt || call.utterances.length || call.phase === 'ended' || call.phase === 'dropped').map((call) => {
      const live = call.phase !== 'ended' && call.phase !== 'dropped';
      const cutOff = cutOffLine(call);
      return {
        ...(call.startedAt ? { at: call.startedAt } : {}), ...(callDuration(call.startedAt, call.endedAt) ? { duration: callDuration(call.startedAt, call.endedAt) } : {}),
        ended: live ? 'still live' : END_REASONS[endReason(call)], ...(cutOff ? { cutOff } : {}),
      };
    }).slice(-4),
    engagement: {
      ...(lastSeenAt ? { lastSeenAt } : {}), visits: state.activity.visits.length + 1, userMessages: userMessages.length,
      unpromptedLast24h: recentUnprompted.length, ...(unprompted.at(-1) ? { lastUnpromptedAt: unprompted.at(-1)!.at } : {}),
    },
    activation: {
      activated: isActivated(state),
      ...(firstValueAt ? { firstValueAt } : {}),
      recurring: {
        status: latestTask?.status ?? 'none', ...(latestTask ? { title: latestTask.title, schedule: latestTask.schedule } : {}),
        ...(lastRun ? { lastRun: lastRun.phase, lastRunAt: lastRun.at } : {}),
      },
    },
    labels: Object.values(state.memory.labels).map((label) => ({ label: label.label, confidence: label.confidence, evidence: label.evidence })),
    notes: state.memory.notes.slice(-NOTE_LIMITS.shown).map((note) => ({ text: note.text, kind: note.kind, source: note.source })),
    ...(state.memory.summary ? { summary: state.memory.summary.text } : {}),
    ...(checkIn ? { checkIn: { wakeAt: checkIn.wakeAt, reason: checkIn.reason } } : {}),
  };
}
