import type { LanguageModel } from 'ai';
import type { SessionEvent } from '../domain/events';
import { projectSession, type SessionProjection } from '../domain/project';
import { buildUserState, callDuration, cutOffLine, END_REASONS, endReason, lifecycleOf, localClock, type UserState } from '../domain/user-state';
import { nextRun } from '../domain/schedule';
import { conversationLines } from './conversation';
import { prepareTurn, type TurnDependencies } from './turn';
import { generateTurnResult, undash } from './runtime';
import { compactionPrompt, runCompaction, runMemory } from './subagents/memory';

/**
 * Follow-ups, server-side. An app event (a call ended, an account connected or failed, a recurring task
 * ran, they came back, a check-in came due) wakes the assistant itself, with its onboarding overlay and
 * a plain note on what happened: it writes one message or calls stay_quiet. Code guardrails decide first
 * and have the last word. The memory reads what's new after every reply and every wake. All of it runs in
 * Next's `after()`, so nothing the user waits on.
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

/** What woke the assistant. The id is stable, so each one is decided once. */
export interface WakeTrigger {
  id: string;
  kind: 'call_ended' | 'connected' | 'connect_failed' | 'not_now' | 'task_ran' | 'task_failed' | 'returned' | 'check_in';
  at: string;
  /** One plain line on what happened, for the assistant and the log. */
  detail: string;
  /** Accounts the follow-up may read (Gmail just connected). */
  include?: Array<'gmail' | 'calendar'>;
}

const DAY_MS = 86_400_000;
const FRESH_MS = 5 * 60_000;
export const DAILY_UNPROMPTED_LIMIT = 2;
const QUIET = { from: 22, to: 8 };

export const GOODBYE = /\b(bye|goodbye|good night|gotta go|got to go|talk (to you )?(later|soon)|ttyl|see (you|ya)|cya|that'?s all|that'?s it for now|i'?m done|signing off)\b/i;
const STOP = /^\s*(please\s+)?stop\s*[.!]*\s*$|\b(stop (messaging|texting|following up|pinging|writing)|don'?t (message|text|ping|write to) me|no more (messages|follow-?ups|reminders|nudges)|leave me alone|unsubscribe)\b/i;

const isQuiet = (hour: number) => hour >= QUIET.from || hour < QUIET.to;
const lastUserTextAt = (state: SessionProjection) => state.messages.filter((message) => message.speaker === 'user').at(-1)?.at ?? '';

/** They asked recently for no more messages, or their last words were a goodbye. */
export function saidStop(state: SessionProjection): 'stop' | 'goodbye' | undefined {
  const said = conversationLines(state).filter((line) => line.speaker === 'user').map((line) => line.text);
  if (said.slice(-20).some((text) => STOP.test(text))) return 'stop';
  if (GOODBYE.test(said.at(-1) ?? '')) return 'goodbye';
  return undefined;
}

/** Triggers in the log nobody has decided on yet: newer than their last message, from the last day. */
export function pendingTriggers(state: SessionProjection, now: Date): WakeTrigger[] {
  const decided = new Set(state.memory.followUps.map((decision) => decision.trigger));
  const since = lastUserTextAt(state);
  const recent = (at?: string) => Boolean(at) && at! > since && now.getTime() - Date.parse(at!) < DAY_MS;
  const triggers: WakeTrigger[] = [];
  for (const call of state.calls) {
    if ((call.phase !== 'ended' && call.phase !== 'dropped') || !recent(call.endedAt)) continue;
    const reason = endReason(call);
    const cutOff = cutOffLine(call);
    const lastUser = [...call.utterances].reverse().find((utterance) => utterance.speaker === 'user')?.text ?? '';
    const endedWithGoodbye = reason === 'goodbye' || GOODBYE.test(lastUser);
    const detail = reason === 'setup_failed' || (!call.startedAt && !call.utterances.length)
      ? 'a call they started never connected'
      : `the browser call ended because ${END_REASONS[reason]}${callDuration(call.startedAt, call.endedAt) ? `, after ${callDuration(call.startedAt, call.endedAt)}` : ''}${cutOff ? `; their last line looks cut off: "${cutOff}"` : ''}${endedWithGoodbye ? '; it ended with a goodbye' : ''}`;
    triggers.push({ id: `call:${call.callId}`, kind: 'call_ended', at: call.endedAt!, detail });
  }
  for (const item of state.timeline) {
    if (item.kind !== 'connection_notice' || item.phase === 'disconnected' || !recent(item.at)) continue;
    const name = item.toolkit === 'gmail' ? 'Gmail' : 'Google Calendar';
    triggers.push(item.phase === 'connected'
      ? { id: `connection:${item.id}`, kind: 'connected', at: item.at!, detail: `they just connected ${name}, and the app confirmed it`, include: [item.toolkit] }
      : { id: `connection:${item.id}`, kind: 'connect_failed', at: item.at!, detail: `connecting ${name} didn't finish (Google's sign-in was cancelled or failed)` });
  }
  for (const tap of state.notNow) {
    if (!recent(tap.at)) continue;
    const what = tap.what === 'call' ? 'the Answer button for a call' : `the Connect ${tap.what === 'gmail' ? 'Gmail' : 'Google Calendar'} button`;
    triggers.push({ id: `not-now:${tap.id}`, kind: 'not_now', at: tap.at, detail: `they tapped Not now on ${what}` });
  }
  for (const run of state.activity.runs) {
    if (!recent(run.at)) continue;
    triggers.push({ id: `task:${run.id}`, kind: run.phase === 'ran' ? 'task_ran' : 'task_failed', at: run.at, detail: `their recurring task "${run.title}" ${run.phase === 'ran' ? 'ran and posted its result in the chat' : 'failed to run'}` });
  }
  const visit = state.activity.visits.at(-1);
  if (visit && recent(visit)) triggers.push({ id: `visit:${visit}`, kind: 'returned', at: visit, detail: 'they came back to the conversation after a while away' });
  // Only the newest check-in counts, and anything they wrote since cancels it.
  const checkIn = state.memory.checkIns.at(-1);
  if (checkIn && checkIn.at > since && checkIn.wakeAt <= now.toISOString()) {
    triggers.push({ id: `check-in:${checkIn.id}`, kind: 'check_in', at: checkIn.wakeAt, detail: `a check-in you scheduled is due: ${checkIn.reason}` });
  }
  return triggers.filter((trigger) => !decided.has(trigger.id)).sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The code guardrails, before any model runs: only safety limits. Whether a message is worth sending (after
 * a goodbye, say) is the assistant's call, made from its onboarding prompt. Undefined lets it decide;
 * otherwise the reason it may not write now, and for quiet hours, when to try again.
 */
export function guard(trigger: WakeTrigger, user: UserState, state: SessionProjection, now: Date): { reason: string; retryAt?: string } | undefined {
  const fresh = now.getTime() - Date.parse(trigger.at) < FRESH_MS && trigger.kind !== 'check_in';
  if (saidStop(state) === 'stop') return { reason: 'they asked not to be messaged' };
  if (state.calls.some((call) => call.phase === 'accepted' || call.phase === 'started')) return { reason: 'a call is live; the call handles it' };
  if (user.engagement.unpromptedLast24h >= DAILY_UNPROMPTED_LIMIT) return { reason: `already ${DAILY_UNPROMPTED_LIMIT} unprompted messages in the last day` };
  // Quiet hours protect people who've stepped away; someone who hung up or opened the page a minute ago is still here.
  if (isQuiet(user.now.hour) && !fresh) return { reason: 'quiet hours', retryAt: nextRun({ cadence: 'daily', time: '08:30' }, user.now.timezone ?? 'UTC', now).toISOString() };
  return undefined;
}

/** The app note a wake-up adds after the conversation (also printed by scripts/show-prompt.ts). */
export function wakeNote(trigger: WakeTrigger, state?: SessionProjection): string {
  return [
    'App note, not from the user: the app woke you; they did not write.',
    `What happened: ${trigger.detail}.`,
    ...(state && saidStop(state) === 'goodbye' ? ['Their last words were a goodbye.'] : []),
    'Decide, as your onboarding guidance says: write one short message (a bubble or two), or call stay_quiet with a short reason. Silence is the default.',
    "If you write, pick the thread back up like a person, then the point. Don't mention this note.",
  ].join('\n');
}

export type WakeResult = { trigger: string; outcome: 'messaged' | 'quiet' | 'skipped'; reason?: string };

/** Decide one trigger once: the guardrails, then the assistant writes or stays quiet. */
export async function wake(deps: FollowUpDeps, sessionId: string, trigger: WakeTrigger): Promise<WakeResult> {
  const skipped: WakeResult = { trigger: trigger.id, outcome: 'skipped' };
  const key = `wake:${trigger.id}`;
  if (!(await deps.store.reserve(sessionId, key))) return skipped;
  const id = `followup:${trigger.id}`;
  const record = async (outcome: 'messaged' | 'quiet', reason: string, guarded?: string) => {
    await deps.store.appendEvent(sessionId, { id: `follow-up:${trigger.id}`, at: (deps.now?.() ?? new Date()).toISOString(), type: 'follow_up', trigger: trigger.id, outcome, reason, ...(guarded ? { guard: guarded } : {}) });
    return { trigger: trigger.id, outcome, reason };
  };
  try {
    const events = await deps.store.readEvents(sessionId);
    const state = projectSession(events);
    if (state.memory.followUps.some((decision) => decision.trigger === trigger.id)) return skipped;
    const now = deps.now?.() ?? new Date();
    const user = buildUserState(state, now, deps.env.OPENAI_VOICE);
    const blocked = guard(trigger, user, state, now);
    if (blocked) {
      if (blocked.retryAt) await deps.store.appendEvent(sessionId, { id: `check-in:quiet:${trigger.id}`, at: now.toISOString(), type: 'check_in', wakeAt: blocked.retryAt, reason: `after quiet hours: ${trigger.detail}` });
      return await record('quiet', blocked.retryAt ? `moved to ${localClock(new Date(blocked.retryAt), user.now.timezone).local}` : blocked.reason, blocked.reason);
    }
    // While the model decides and writes, the open page shows typing dots (a `reach:` reservation; see
    // /api/agent/updates). The `wake:` one above is the permanent once-per-trigger lock, so it can't be that signal.
    const writing = `reach:${trigger.id}`;
    await deps.store.reserve(sessionId, writing);
    let result: Awaited<ReturnType<typeof generateTurnResult>>;
    try {
      const turn = await prepareTurn(deps, sessionId, events, { turnId: id, trigger: { id, instruction: wakeNote(trigger, state), ...(trigger.include ? { include: trigger.include } : {}) } });
      result = await generateTurnResult(turn, deps.env, deps.model);
    } finally {
      await deps.store.releaseReservation(sessionId, writing);
    }
    const quiet = result.steps.flatMap((step) => step.toolResults).find((item) => item.toolName === 'stay_quiet');
    if (quiet) return await record('quiet', String((quiet.input as { reason?: unknown } | undefined)?.reason ?? 'chose to stay quiet'));
    const text = undash(result.steps.map((step) => step.text.trim()).filter(Boolean).join('\n\n'));
    // They wrote while this was being written: their reply is answered instead, and this one would talk over it.
    const latest = projectSession(await deps.store.readEvents(sessionId));
    if (lastUserTextAt(latest) !== lastUserTextAt(state)) return await record('quiet', 'they wrote in the meantime');
    if (!text) return await record('quiet', 'no message written');
    await deps.store.appendEvent(sessionId, { id: `answer:${id}`, at: (deps.now?.() ?? new Date()).toISOString(), type: 'message', speaker: 'assistant', channel: 'text', text, origin: 'follow_up' });
    return await record('messaged', trigger.detail);
  } catch (error) {
    // A failed model call releases the trigger so the next wake can try again.
    await deps.store.releaseReservation(sessionId, key);
    throw error;
  }
}

/**
 * Let the memory read what's new, and fold the older conversation into the rolling summary once it has
 * outgrown its budget. The two run side by side; each is idempotent (per conversation length, per watermark).
 */
export async function updateMemory(deps: FollowUpDeps, sessionId: string): Promise<number> {
  const state = projectSession(await deps.store.readEvents(sessionId));
  const lines = conversationLines(state).length;
  const now = deps.now?.() ?? new Date();
  const agent = { env: deps.env, trace: deps.trace, model: deps.model };
  const fold = compactionPrompt(state, deps.env);
  const [read, folded] = await Promise.all([
    deps.store.reserve(sessionId, `memory:${lines}`).then((reserved) => (reserved ? runMemory(agent, sessionId, state, now) : [])),
    fold ? deps.store.reserve(sessionId, `compaction:${fold.key}`).then((reserved) => (reserved ? runCompaction(agent, sessionId, fold, now) : [])) : [],
  ]);
  const events = [...read, ...folded];
  for (const event of events) await deps.store.appendEvent(sessionId, event);
  return events.length;
}

/** After the assistant answered a user message: the memory reads it. No other model call. */
export async function afterTurn(deps: FollowUpDeps, sessionId: string, userEventId: string): Promise<void> {
  const events = await deps.store.readEvents(sessionId);
  if (!events.some((event) => event.id === `answer:${userEventId}`)) return;
  await updateMemory(deps, sessionId).catch((error) => console.error('Memory failed', error));
}

/**
 * Everything owed for a session: triggers nobody decided on, then the memory. Safe to call any number of
 * times from any route: each trigger is decided once. Only during onboarding: settled-in users get no
 * unprompted messages.
 */
export async function reconcile(deps: FollowUpDeps, sessionId: string): Promise<WakeResult[]> {
  const now = deps.now?.() ?? new Date();
  const state = projectSession(await deps.store.readEvents(sessionId));
  const results: WakeResult[] = [];
  if (lifecycleOf(state, now).stage === 'onboarding') {
    for (const trigger of pendingTriggers(state, now)) {
      try { results.push(await wake(deps, sessionId, trigger)); }
      catch (error) { console.error('Follow-up failed', trigger.id, error); }
    }
  }
  try { await updateMemory(deps, sessionId); } catch (error) { console.error('Memory failed', error); }
  return results;
}
