import type { SessionEvent } from '../../lib/domain/events';
import { projectSession } from '../../lib/domain/project';
import { userWords } from '../../lib/agent/turn';
import { checkInvariants, type CheckResult } from '../app/invariants';
import type { StepTrace } from '../app/replay';
import type { SimAction } from './user';
import type { SimStep, SimToolTrace, SimTrace } from './run';

/** How far one simulated person got. Every stage is computed from the final state and the trace. */
export interface SimStages {
  /** The person gave the assistant a name, in their own words. */
  named: boolean;
  /** The assistant knows what to call them, or they declined to say. */
  knowsUser: boolean;
  needKnown: boolean;
  /** A call offer card appeared. */
  callOffered: boolean;
  callHappened: boolean;
  gmailConnected: boolean;
  calendarConnected: boolean;
  /** An account read returned items and, in the same step, the assistant then told them about one. */
  firstValue: boolean;
  taskProposed: boolean;
  /** A recurring task was approved. */
  activated: boolean;
  /**
   * The brief's four things are settled and the call was offered: a name for the assistant, the user's
   * name (or their decline), the need, a Gmail decision, and a call offer card, a call held, or a call
   * declined. The prompt offers the call in words first and a "no" is recorded without any card, so a
   * declined call counts as offered here even when `callOffered` (the card) is false.
   */
  briefComplete: boolean;
  /** They did not leave annoyed, bored or confused, and the conversation did not fail. */
  stayed: boolean;
  /** Actions the person took. */
  turns: number;
}

const UNHAPPY = new Set(['annoyed', 'bored', 'confused']);

export function scoreTrace(trace: Pick<SimTrace, 'events' | 'steps' | 'status' | 'leave'>): SimStages {
  const state = projectSession(trace.events);
  const progress = state.onboarding;
  const named = progress.assistantName.status === 'confirmed';
  const knowsUser = progress.preferredName.status === 'confirmed' || progress.preferredName.status === 'declined';
  const needKnown = progress.need.status === 'confirmed' || progress.need.status === 'tentative';
  const callOffered = state.timeline.some((item) => item.kind === 'call_offer');
  const callHappened = progress.call === 'happened';
  const callSettled = callOffered || callHappened || progress.call === 'declined';
  return {
    named,
    knowsUser,
    needKnown,
    callOffered,
    callHappened,
    gmailConnected: state.connections.gmail === 'connected',
    calendarConnected: state.connections.calendar === 'connected',
    firstValue: firstValueStep(trace.steps) !== undefined,
    taskProposed: state.automations.length > 0,
    activated: trace.events.some((event) => event.type === 'automation' && event.phase === 'approved'),
    briefComplete: named && knowsUser && needKnown && (progress.gmail === 'connected' || progress.gmail === 'declined') && callSettled,
    stayed: trace.status !== 'error' && !(trace.leave && UNHAPPY.has(trace.leave.feeling)),
    turns: trace.steps.length,
  };
}

/** The person's own words up to and including each step (typed, or as spoken and heard). */
export function wordsSoFar(steps: Array<Pick<SimStep, 'action' | 'delivered'>>): string[][] {
  const said: string[] = [];
  return steps.map((step) => {
    if (step.action.type === 'say' || step.action.type === 'speak') said.push(step.delivered ?? step.action.text);
    return [...said];
  });
}

/** The first step that showed the person something from their accounts, with the term that proves it. */
export function firstValueStep(steps: Array<Pick<SimStep, 'index' | 'turns' | 'action' | 'delivered'>>): { index: number; term: string } | undefined {
  const said = wordsSoFar(steps);
  for (const [position, step] of steps.entries()) {
    const term = valueMention(step, said[position]);
    if (term !== undefined) return { index: step.index, term };
  }
  return undefined;
}

interface ReadItem { from?: unknown; subject?: unknown; summary?: unknown }

/** The items an account read returned: Gmail message summaries or calendar events. */
export function readItems(tool: Pick<SimToolTrace, 'name' | 'output'>): ReadItem[] {
  const output = tool.output as { status?: unknown; messages?: unknown; events?: unknown } | undefined;
  if (!output || typeof output !== 'object' || output.status !== 'ok') return [];
  const list = tool.name === 'search_gmail' ? output.messages : tool.name === 'read_calendar_window' ? output.events : undefined;
  return Array.isArray(list) ? list.filter((item): item is ReadItem => Boolean(item) && typeof item === 'object') : [];
}

/**
 * Words too generic to prove the assistant is talking about a specific email or event, including day
 * and month names ("Want me to check again Thursday?" names no finding).
 */
const GENERIC = new Set([
  'the', 'and', 'for', 'with', 'from', 'your', 'you', 'our', 'this', 'that', 'what', 'about', 'have', 'will', 'just', 'can', 'need', 'needs',
  'answer', 'reply', 'action', 'required', 'update', 'updates', 'meeting', 'meetings', 'call', 'sync', 'week', 'weekly', 'daily', 'today',
  'tomorrow', 'time', 'next', 'last', 'move', 'team', 'account', 'alerts', 'alert', 'notice', 'news', 'info', 'support', 'noreply',
  'no-reply', 'notifications', 'email', 'emails', 'mail', 'message', 'messages', 'inbox', 'calendar', 'event', 'events', 'schedule',
  'plan', 'please', 'thanks', 'hello', 'me',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
]);

export interface Term { text: string; caseSensitive: boolean }

/**
 * What identifies one read item in a reply: the sender's display name and its proper names, the
 * subject or event title, and their distinctive words. Proper names match case-sensitively.
 */
export function itemTerms(item: ReadItem): Term[] {
  const terms: Term[] = [];
  const add = (text: string, caseSensitive = false) => {
    if (text && !GENERIC.has(text.toLowerCase()) && !terms.some((term) => term.text === text)) terms.push({ text, caseSensitive });
  };
  const display = typeof item.from === 'string' ? item.from.replace(/<[^>]*>/g, '').replace(/"/g, '').trim() : '';
  if (display) {
    add(display);
    for (const token of display.split(/\s+/)) if (/^\p{Lu}[\p{L}'-]{2,}$/u.test(token)) add(token, true);
  }
  for (const title of [item.subject, item.summary]) {
    if (typeof title !== 'string' || !title.trim()) continue;
    add(title.trim());
    for (const token of title.split(/[^\p{L}\p{N}:']+/u)) {
      const word = token.replace(/^[:']+|[:']+$/g, '');
      if (/^\d+:\d+$/.test(word)) add(word);
      else if (/^\p{Lu}\p{Ll}{2}$/u.test(word)) add(word, true);
      else if (word.length >= 4 && /\p{L}/u.test(word)) add(word);
    }
  }
  return terms;
}

export function mentions(text: string, term: Term): boolean {
  const escaped = term.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, term.caseSensitive ? 'u' : 'iu').test(text);
}

/**
 * The term that shows the assistant told the person something it found: an account read in this step
 * returned items, and text the person saw after that result (later model steps of the same turn, or a
 * later turn in the step) names one of them. A single word the person already said ("lease", "Dana")
 * is an echo, not a finding; a full sender name or subject still counts. Undefined when the step
 * showed no such value.
 */
export function valueMention(step: Pick<SimStep, 'turns'>, said: string[] = []): string | undefined {
  const echoed = (term: Term) => !/\s/.test(term.text)
    && said.some((text) => mentions(text, { text: term.text, caseSensitive: false }) || mentions(text, { text: `${term.text}s`, caseSensitive: false }));
  for (const [index, turn] of step.turns.entries()) {
    for (const tool of turn.tools) {
      const terms = readItems(tool).flatMap(itemTerms).filter((term) => !echoed(term));
      if (!terms.length) continue;
      const later = [
        ...(turn.shown ? turn.stepTexts.slice(tool.modelStep + 1) : []),
        ...step.turns.slice(index + 1).filter((next) => next.shown).map((next) => next.text),
      ];
      for (const text of later) {
        const hit = terms.find((term) => mentions(text, term));
        if (hit) return hit.text;
      }
    }
  }
  return undefined;
}

export function describeAction(action: SimAction): string {
  switch (action.type) {
    case 'say': return `say: ${action.text}`;
    case 'speak': return `speak: ${action.text}`;
    case 'tap': return `tap: ${action.control}`;
    case 'hang_up': return 'hang up';
    case 'leave': return `leave (${action.feeling}): ${action.reason}`;
  }
}

/** The offer_call gate's words for asking for a call (lib/agent/actions.ts keeps its copy private). */
const CALL_WORDS = /\b(call|calling|talk|phone|voice|ring|speak)\b/i;

/**
 * The replay's hard invariants (false claims, followed injections, re-asks, unauthorized reads) over a
 * simulated conversation, adapted where a live conversation differs from a scripted one: the "call
 * started" claim is checked on text only (on a live call, "I'm calling you from the chat" is true), and
 * an offer after a decline is allowed when the person asked for a call again. A step whose turn failed
 * is the conversation's error, so it is left out.
 */
export function simInvariants(trace: SimTrace): CheckResult[] {
  const complete = trace.steps.filter((step) => !step.incomplete);
  const steps = (spoken: boolean): StepTrace[] => complete.map((step) => ({
    index: step.index,
    kind: step.action.type === 'say' ? 'user'
      : step.action.type === 'tap' && step.action.control.startsWith('connect_') ? 'connect'
        : step.action.type === 'tap' && step.action.control.startsWith('not_now_') ? 'decline' : 'call',
    input: describeAction(step.action),
    output: step.turns.filter((turn) => turn.shown && (spoken || turn.channel === 'text')).map((turn) => turn.text.trim()).join('\n\n') || null,
    tools: step.turns.flatMap((turn) => turn.tools.map(({ name, input, output }) => ({ name, input, output }))),
    connected: step.connected,
    ...(step.followUp ? { followUp: step.followUp } : {}),
  }));
  const base = {
    scenarioId: trace.personaId, promptVersion: trace.promptVersion, fixtureVersion: trace.fixtureVersion, reads: trace.reads,
    finalProgress: trace.finalProgress, events: trace.events,
  };
  const typed = checkInvariants({ ...base, steps: steps(false) });
  return checkInvariants({ ...base, steps: steps(true) }).map((check) => {
    if (check.id === 'no_call_started_claim') return typed.find((item) => item.id === check.id) ?? check;
    if (check.id === 'no_call_offer_after_decline') return offerAfterDecline(trace.events);
    return check;
  });
}

/**
 * No call offer after the person said no, unless their latest words asked for a call (the offer_call
 * gate's own exception). A call they took, or an offer they asked for, supersedes the earlier no; a no
 * said after a call still counts, which the gate itself misses.
 */
export function offerAfterDecline(events: SessionEvent[]): CheckResult {
  let declined = false;
  for (const [index, event] of events.entries()) {
    if (event.type !== 'call') continue;
    if (event.phase === 'declined') declined = true;
    else if (event.phase === 'accepted' || event.phase === 'started') declined = false;
    else if (event.phase === 'offered' && declined) {
      const latest = userWords(projectSession(events.slice(0, index))).at(-1) ?? '';
      if (!CALL_WORDS.test(latest)) return { id: 'no_call_offer_after_decline', passed: false, detail: event.id };
      declined = false;
    }
  }
  return { id: 'no_call_offer_after_decline', passed: true };
}
