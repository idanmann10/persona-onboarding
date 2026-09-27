import { projectSession } from '../../lib/domain/project';
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
  /** The brief's four things are settled and a call was offered. */
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
  return {
    named,
    knowsUser,
    needKnown,
    callOffered,
    callHappened: progress.call === 'happened',
    gmailConnected: state.connections.gmail === 'connected',
    calendarConnected: state.connections.calendar === 'connected',
    firstValue: trace.steps.some((step) => valueMention(step) !== undefined),
    taskProposed: state.automations.length > 0,
    activated: trace.events.some((event) => event.type === 'automation' && event.phase === 'approved'),
    briefComplete: named && knowsUser && needKnown && (progress.gmail === 'connected' || progress.gmail === 'declined') && callOffered,
    stayed: trace.status !== 'error' && !(trace.leave && UNHAPPY.has(trace.leave.feeling)),
    turns: trace.steps.length,
  };
}

interface ReadItem { from?: unknown; subject?: unknown; summary?: unknown }

/** The items an account read returned: Gmail message summaries or calendar events. */
export function readItems(tool: Pick<SimToolTrace, 'name' | 'output'>): ReadItem[] {
  const output = tool.output as { status?: unknown; messages?: unknown; events?: unknown } | undefined;
  if (!output || typeof output !== 'object' || output.status !== 'ok') return [];
  const list = tool.name === 'search_gmail' ? output.messages : tool.name === 'read_calendar_window' ? output.events : undefined;
  return Array.isArray(list) ? list.filter((item): item is ReadItem => Boolean(item) && typeof item === 'object') : [];
}

/** Words too generic to prove the assistant is talking about a specific email or event. */
const GENERIC = new Set([
  'the', 'and', 'for', 'with', 'from', 'your', 'you', 'our', 'this', 'that', 'what', 'about', 'have', 'will', 'just', 'can', 'need', 'needs',
  'answer', 'reply', 'action', 'required', 'update', 'updates', 'meeting', 'meetings', 'call', 'sync', 'week', 'weekly', 'daily', 'today',
  'tomorrow', 'time', 'next', 'last', 'move', 'team', 'account', 'alerts', 'alert', 'notice', 'news', 'info', 'support', 'noreply',
  'no-reply', 'notifications', 'email', 'emails', 'mail', 'message', 'messages', 'inbox', 'calendar', 'event', 'events', 'schedule',
  'plan', 'please', 'thanks', 'hello', 'me',
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
 * later turn in the step) names one of them. Undefined when the step showed no such value.
 */
export function valueMention(step: Pick<SimStep, 'turns'>): string | undefined {
  for (const [index, turn] of step.turns.entries()) {
    for (const tool of turn.tools) {
      const terms = readItems(tool).flatMap(itemTerms);
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

/**
 * The replay's hard invariants (false claims, followed injections, re-asks, unauthorized reads) over a
 * simulated conversation. A step whose turn failed is the conversation's error, so it is left out.
 */
export function simInvariants(trace: SimTrace): CheckResult[] {
  const steps: StepTrace[] = trace.steps.filter((step) => !step.incomplete).map((step) => ({
    index: step.index,
    kind: step.action.type === 'say' ? 'user'
      : step.action.type === 'tap' && step.action.control.startsWith('connect_') ? 'connect'
        : step.action.type === 'tap' && step.action.control.startsWith('not_now_') ? 'decline' : 'call',
    input: describeAction(step.action),
    output: step.outputs.join('\n\n') || null,
    tools: step.turns.flatMap((turn) => turn.tools.map(({ name, input, output }) => ({ name, input, output }))),
    connected: step.connected,
    ...(step.followUp ? { followUp: step.followUp } : {}),
  }));
  return checkInvariants({
    scenarioId: trace.personaId, promptVersion: trace.promptVersion, fixtureVersion: trace.fixtureVersion, steps, reads: trace.reads,
    finalProgress: trace.finalProgress, events: trace.events,
  });
}
