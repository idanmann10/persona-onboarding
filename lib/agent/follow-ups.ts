import type { LanguageModel } from 'ai';
import type { SessionEvent } from '../domain/events';
import { projectSession, type SessionProjection } from '../domain/project';
import { buildUserState, callDuration, cutOffLine, END_REASONS, endReason, type UserState } from '../domain/user-state';
import { acceptSoulNote } from '../domain/memory';
import { SETUP_LABELS } from '../domain/onboarding';
import { nextRun } from '../domain/schedule';
import { conversationLines } from './conversation';
import { prepareTurn, type TurnDependencies } from './turn';
import { generateTurn } from './runtime';
import { isSetupItem, runCoach, type CoachOutput, type CoachTrigger } from './subagents/coach';
import { runMemory } from './subagents/memory';

/**
 * Background work after the assistant speaks or the app records something: the onboarding coach decides
 * whether to reach out and what to steer toward, the memory keeps what's worth knowing. Runs in Next's
 * `after()`, so no reply waits on it. Code guardrails here have the last word over the coach.
 */
export interface FollowUpDeps extends TurnDependencies {
  store: TurnDependencies['store'] & {
    readEvents(id: string): Promise<SessionEvent[]>;
    reserve(id: string, key: string): Promise<boolean>;
    releaseReservation(id: string, key: string): Promise<void>;
  };
  /** A scripted model for the eval harness. */
  model?: LanguageModel;
}

const DAY_MS = 86_400_000;
const FRESH_MS = 5 * 60_000;
export const DAILY_UNPROMPTED_LIMIT = 2;
const QUIET = { from: 22, to: 8 };

const GOODBYE = /\b(bye|goodbye|good night|gotta go|got to go|talk (to you )?(later|soon)|ttyl|see (you|ya)|cya|that'?s all|that'?s it for now|i'?m done|signing off)\b/i;
const STOP = /^\s*(please\s+)?stop\s*[.!]*\s*$|\b(stop (messaging|texting|following up|pinging|writing)|don'?t (message|text|ping|write to) me|no more (messages|follow-?ups|reminders|nudges)|leave me alone|unsubscribe)\b/i;

/** They said goodbye last, or asked recently for no more messages. */
export function saidStop(state: SessionProjection): string | undefined {
  const said = conversationLines(state).filter((line) => line.speaker === 'user').map((line) => line.text);
  if (said.slice(-20).some((text) => STOP.test(text))) return 'they asked not to be messaged';
  if (GOODBYE.test(said.at(-1) ?? '')) return 'their last words were a goodbye';
  return undefined;
}

const isQuiet = (hour: number) => hour >= QUIET.from || hour < QUIET.to;

/** Triggers in the log nobody has decided on yet: newer than their last message, from the last day. */
export function pendingTriggers(state: SessionProjection, now: Date): CoachTrigger[] {
  const decided = new Set(state.memory.coach.map((decision) => decision.trigger));
  const lastUserText = state.messages.filter((message) => message.speaker === 'user').at(-1)?.at ?? '';
  const recent = (at?: string) => Boolean(at) && at! > lastUserText && now.getTime() - Date.parse(at!) < DAY_MS;
  const triggers: CoachTrigger[] = [];
  for (const call of state.calls) {
    if ((call.phase !== 'ended' && call.phase !== 'dropped') || !recent(call.endedAt)) continue;
    const reason = endReason(call);
    const cutOff = cutOffLine(call);
    const detail = reason === 'setup_failed' || (!call.startedAt && !call.utterances.length)
      ? "a call they started never connected"
      : `the browser call ended because ${END_REASONS[reason]}${callDuration(call.startedAt, call.endedAt) ? `, after ${callDuration(call.startedAt, call.endedAt)}` : ''}${cutOff ? `; their last line looks cut off: "${cutOff}"` : ''}`;
    triggers.push({ id: `call:${call.callId}`, kind: 'call_ended', at: call.endedAt!, detail });
  }
  for (const item of state.timeline) {
    if (item.kind !== 'connection_notice' || item.phase === 'disconnected' || !recent(item.at)) continue;
    const name = item.toolkit === 'gmail' ? 'Gmail' : 'Google Calendar';
    triggers.push(item.phase === 'connected'
      ? { id: `connection:${item.id}`, kind: 'connected', at: item.at!, detail: `they just connected ${name}, and the app confirmed it`, include: [item.toolkit] }
      : { id: `connection:${item.id}`, kind: 'connect_failed', at: item.at!, detail: `connecting ${name} didn't finish (Google's sign-in was cancelled or failed)` });
  }
  for (const run of state.activity.runs) {
    if (!recent(run.at)) continue;
    triggers.push({ id: `task:${run.id}`, kind: run.phase === 'ran' ? 'task_ran' : 'task_failed', at: run.at, detail: `their recurring task "${run.title}" ${run.phase === 'ran' ? 'ran and posted its result in the chat' : 'failed to run'}` });
  }
  const visit = state.activity.visits.at(-1);
  if (visit && recent(visit)) triggers.push({ id: `visit:${visit}`, kind: 'returned', at: visit, detail: 'they came back to the conversation after a while away' });
  // Only the newest decision's check-in counts: a later read replaces an earlier plan.
  const latest = state.memory.coach.at(-1);
  if (latest?.reachOut === 'later' && latest.wakeAt && latest.wakeAt <= now.toISOString() && latest.at > lastUserText) {
    triggers.push({ id: `wake:${latest.id}`, kind: 'check_in', at: latest.wakeAt, detail: `a check-in scheduled earlier is due (${latest.why})` });
  }
  return triggers.filter((trigger) => !decided.has(trigger.id)).sort((a, b) => a.at.localeCompare(b.at));
}

/** The coach proposes; these rules dispose. Returns the final decision and what overrode it, if anything. */
export function guard(trigger: CoachTrigger, output: CoachOutput, user: UserState, state: SessionProjection, now: Date): { reachOut: 'now' | 'later' | 'no'; wakeAt?: string; guard?: string } {
  const stop = saidStop(state);
  if (output.reach_out === 'no') return { reachOut: 'no' };
  if (stop) return { reachOut: 'no', guard: stop };
  const zone = user.now.timezone ?? 'UTC';
  const morning = () => nextRun({ cadence: 'daily', time: '08:00' }, zone, now).toISOString();
  if (output.reach_out === 'later') {
    const at = new Date(now.getTime() + (output.later_in_minutes ?? 180) * 60_000);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(at)) % 24;
    return isQuiet(hour) ? { reachOut: 'later', wakeAt: nextRun({ cadence: 'daily', time: '08:00' }, zone, at).toISOString(), guard: 'moved out of quiet hours' } : { reachOut: 'later', wakeAt: at.toISOString() };
  }
  if (trigger.kind === 'after_turn') return { reachOut: 'no', guard: 'they just got a reply' };
  if (state.calls.some((call) => call.phase === 'accepted' || call.phase === 'started')) return { reachOut: 'no', guard: 'a call is live; the call handles it' };
  if (user.engagement.unpromptedLast24h >= DAILY_UNPROMPTED_LIMIT) return { reachOut: 'no', guard: `already ${DAILY_UNPROMPTED_LIMIT} unprompted messages in the last day` };
  // Quiet hours protect people who've stepped away; someone who hung up or opened the page a minute ago is still here.
  const fresh = now.getTime() - Date.parse(trigger.at) < FRESH_MS && trigger.kind !== 'check_in';
  if (isQuiet(user.now.hour) && !fresh) return { reachOut: 'later', wakeAt: morning(), guard: 'quiet hours' };
  return { reachOut: 'now' };
}

function followUpNote(trigger: CoachTrigger, output: CoachOutput): string {
  const aim = isSetupItem(output.focus) ? SETUP_LABELS[output.focus] : output.focus.replace(/_/g, ' ');
  return [
    "App note, not from the user: you're writing first, unprompted.",
    `What happened: ${trigger.detail}.`,
    `Why it's worth a message: ${output.why}`,
    `Aim: ${aim}. ${output.guidance}`,
    "Write like a person picking the thread back up: a few words on what just happened if it helps (\"looks like we got cut off\"), then the point. One short message, a bubble or two. No recap, and don't mention this note or that anything prompted you.",
  ].join('\n');
}

async function reachOut(deps: FollowUpDeps, sessionId: string, trigger: CoachTrigger, output: CoachOutput): Promise<boolean> {
  const key = `reach:${trigger.id}`;
  if (!(await deps.store.reserve(sessionId, key))) return false;
  try {
    const events = await deps.store.readEvents(sessionId);
    const id = `followup:${trigger.id}`;
    const turn = await prepareTurn(deps, sessionId, events, { turnId: id, trigger: { id, instruction: followUpNote(trigger, output), ...(trigger.include ? { include: trigger.include } : {}) } });
    const text = (await generateTurn(turn, deps.env, deps.model)).trim();
    // They wrote while this was being written: their reply is answered instead, and this one would talk over it.
    const latest = projectSession(await deps.store.readEvents(sessionId));
    if (!text || latest.messages.filter((message) => message.speaker === 'user').length > turn.state.messages.filter((message) => message.speaker === 'user').length) return false;
    const at = (deps.now?.() ?? new Date()).toISOString();
    await deps.store.appendEvent(sessionId, { id: `answer:${id}`, at, type: 'message', speaker: 'assistant', channel: 'text', text, origin: 'follow_up' });
    if (isSetupItem(output.focus)) await deps.store.appendEvent(sessionId, { id: `ask:${id}:${output.focus}`, at, type: 'setup_ask', item: output.focus, source: id });
    return true;
  } finally {
    await deps.store.releaseReservation(sessionId, key);
  }
}

export type CoachResult = { trigger: string; decision: 'skipped' | 'no' | 'later' | 'now'; messaged?: boolean; guard?: string };

/** Decide one trigger once: the coach reads, the guard rules, and a "now" becomes one follow-up message. */
export async function decideTrigger(deps: FollowUpDeps, sessionId: string, trigger: CoachTrigger): Promise<CoachResult> {
  const skipped: CoachResult = { trigger: trigger.id, decision: 'skipped' };
  const state = projectSession(await deps.store.readEvents(sessionId));
  if (state.memory.coach.some((decision) => decision.trigger === trigger.id)) return skipped;
  const now = deps.now?.() ?? new Date();
  const user = buildUserState(state, now, deps.env.OPENAI_VOICE);
  // The coach exists for onboarding; once they're settled in, silence.
  if (user.lifecycle.stage !== 'onboarding') return skipped;
  const key = `coach:${trigger.id}`;
  if (!(await deps.store.reserve(sessionId, key))) return skipped;
  const output = await runCoach({ env: deps.env, trace: deps.trace, model: deps.model }, sessionId, trigger, state, user, now);
  if (!output) { await deps.store.releaseReservation(sessionId, key); return skipped; }
  const ruled = guard(trigger, output, user, state, now);
  // A declined item is closed, whatever the coach thought.
  const focus = isSetupItem(output.focus) && user.setup[output.focus].status === 'declined' ? 'nothing' : output.focus;
  const decided = { ...output, focus };
  const at = now.toISOString();
  await deps.store.appendEvent(sessionId, {
    id: key, at, type: 'coach', trigger: trigger.id, reachOut: ruled.reachOut, ...(ruled.wakeAt ? { wakeAt: ruled.wakeAt } : {}),
    why: output.why, focus, guidance: output.guidance, ...(ruled.guard ? { guard: ruled.guard } : {}),
  });
  if (trigger.kind === 'after_turn') {
    for (const item of new Set(output.asked_in_last_reply)) await deps.store.appendEvent(sessionId, { id: `ask:${trigger.id}:${item}`, at, type: 'setup_ask', item, source: trigger.id });
  }
  if (output.soul_note) {
    const accepted = acceptSoulNote(state, 'coach', output.soul_note);
    if (accepted.ok) await deps.store.appendEvent(sessionId, { id: `soul:coach:${trigger.id}`, at, type: 'soul_note', agent: 'coach', text: accepted.text, source: key });
  }
  const messaged = ruled.reachOut === 'now' ? await reachOut(deps, sessionId, trigger, decided) : undefined;
  return { trigger: trigger.id, decision: ruled.reachOut, ...(messaged === undefined ? {} : { messaged }), ...(ruled.guard ? { guard: ruled.guard } : {}) };
}

/** Let the memory read what's new. Idempotent per conversation length. */
export async function updateMemory(deps: FollowUpDeps, sessionId: string): Promise<number> {
  const state = projectSession(await deps.store.readEvents(sessionId));
  const lines = conversationLines(state).length;
  if (!(await deps.store.reserve(sessionId, `memory:${lines}`))) return 0;
  const events = await runMemory({ env: deps.env, trace: deps.trace, model: deps.model }, sessionId, state, deps.now?.() ?? new Date());
  for (const event of events) await deps.store.appendEvent(sessionId, event);
  return events.length;
}

/** After the assistant answered a user message: the coach (while onboarding) and the memory, side by side. */
export async function afterTurn(deps: FollowUpDeps, sessionId: string, userEventId: string): Promise<void> {
  const events = await deps.store.readEvents(sessionId);
  const answer = events.find((event) => event.id === `answer:${userEventId}`);
  if (!answer) return;
  const trigger: CoachTrigger = { id: `turn:${userEventId}`, kind: 'after_turn', at: answer.at, detail: 'the assistant just answered their message' };
  await Promise.allSettled([decideTrigger(deps, sessionId, trigger), updateMemory(deps, sessionId)]);
}

/**
 * Everything owed for a session: triggers nobody decided on (a call ended, an account connected or
 * failed, a task ran, they came back, a check-in came due), then the memory. Safe to call any number
 * of times from any route: each trigger is decided once.
 */
export async function reconcile(deps: FollowUpDeps, sessionId: string): Promise<CoachResult[]> {
  const now = deps.now?.() ?? new Date();
  const results: CoachResult[] = [];
  for (const trigger of pendingTriggers(projectSession(await deps.store.readEvents(sessionId)), now)) {
    try { results.push(await decideTrigger(deps, sessionId, trigger)); }
    catch (error) { console.error('Follow-up trigger failed', trigger.id, error); }
  }
  try { await updateMemory(deps, sessionId); } catch (error) { console.error('Memory failed', error); }
  return results;
}
