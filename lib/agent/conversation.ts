import type { ModelMessage } from 'ai';
import type { SessionProjection } from '../domain/project';
import { BUDGET, compactionBudget, clipToTokens, estimateTokens } from './budget';

/**
 * The conversation as lines, typed or spoken, and the part of it a prompt replays. Lines before the
 * rolling summary's watermark are folded into the summary; the rest are replayed verbatim, newest kept
 * within the history budget, with old bulky lines trimmed (the "history diet"). When the verbatim part
 * outgrows its roll budget, the memory folds its older part into the summary in the background
 * (lib/agent/subagents/memory.ts), so a turn never waits on compaction.
 */

export type Line = { speaker: 'user' | 'assistant'; text: string; voice: boolean; at?: string; id?: string; origin?: string; /** An app line (a card, a tap), never the user's words. */ card?: boolean };

const MESSAGE_LIMIT = 40;
/** One line never takes more than this, however long it was. */
const LINE_CHARS = 4_000;
/** The history diet: lines older than the newest few that are this bulky keep only their start. */
const DIET = { recent: 6, lineTokens: 250 };

/**
 * Every line of the conversation in order, typed or spoken. With `cards`, also the cards put on screen and
 * what they tapped, as bracketed app lines: only for what a prompt replays, never as the user's words.
 */
export function conversationLines(state: SessionProjection, options: { cards?: boolean } = {}): Line[] {
  const lines: Line[] = [];
  const at = new Map(state.messages.map((message) => [message.id, message.at]));
  for (const item of state.timeline) {
    if (item.kind === 'message' && item.text.trim()) lines.push({ speaker: item.speaker, text: item.text, voice: item.channel === 'voice', at: at.get(item.id), id: item.id, ...(item.origin ? { origin: item.origin } : {}) });
    if (item.kind === 'call') for (const utterance of item.call.utterances) lines.push({ speaker: utterance.speaker, text: utterance.text, voice: true, at: item.call.startedAt, id: `call:${item.call.callId}` });
    // Cards and what they did with them, as app lines in brackets, so the model knows what was on screen
    // (without them it once denied putting up a button the user had just tapped Not now on).
    const card = (speaker: Line['speaker'], text: string) => { if (options.cards) lines.push({ speaker, text: `[${text}]`, voice: false, id: `card:${item.id}:${speaker}`, card: true }); };
    if (item.kind === 'connection_offer') {
      const name = item.toolkit === 'gmail' ? 'Gmail' : 'Google Calendar';
      card('assistant', `put a Connect ${name} button on screen`);
      if (item.status === 'declined') card('user', `tapped Not now on the Connect ${name} button`);
    }
    if (item.kind === 'connection_notice' && item.phase !== 'disconnected') card('user', item.phase === 'connected' ? `connected ${item.toolkit === 'gmail' ? 'Gmail' : 'Google Calendar'}` : `the ${item.toolkit === 'gmail' ? 'Gmail' : 'Google Calendar'} sign-in didn't finish`);
    if (item.kind === 'call_offer') {
      card('assistant', 'put an Answer button on screen for a short call');
      if (item.status === 'declined') card('user', 'tapped Not now on the call');
    }
    if (item.kind === 'automation') {
      card('assistant', `put a recurring-task preview on screen: "${item.title}", ${item.schedule}`);
      if (item.status === 'active') card('user', 'approved it');
      if (item.status === 'declined') card('user', 'tapped Not now on it');
      if (item.status === 'disabled') card('user', 'turned it off');
    }
  }
  return lines;
}

const lineTokens = (line: Line) => estimateTokens(line.text.slice(0, LINE_CHARS));

/** An old line past the diet's size keeps its start and says it was cut; the log keeps all of it. */
function diet(line: Line): Line {
  if (estimateTokens(line.text) <= DIET.lineTokens) return line;
  return { ...line, text: `${clipToTokens(line.text, DIET.lineTokens)} [older long message trimmed]` };
}

export interface HistoryWindow {
  /** The first replayed line; everything before it is in the summary (or past the hard cap). */
  start: number;
  lines: Line[];
  tokens: number;
  /** Old lines the diet trimmed. */
  trimmed: number;
  /** Lines past the summary's watermark that didn't fit the budget (the summary is catching up). */
  dropped: number;
}

/** What a prompt replays: the lines after the summary's watermark, newest first until the budget is spent. */
export function historyWindow(state: SessionProjection, budget: number = BUDGET.text.history): HistoryWindow {
  const lines = conversationLines(state, { cards: true });
  // The summary's watermark counts spoken and typed lines only; find where it falls among lines with cards.
  const words = lines.filter((line) => !line.card).length;
  const watermark = Math.min(state.memory.summary?.lines ?? 0, words);
  let first = 0;
  for (let seen = 0; first < lines.length && seen < watermark; first++) if (!lines[first].card) seen++;
  const kept: Line[] = [];
  let tokens = 0;
  let trimmed = 0;
  for (let index = lines.length - 1; index >= first && kept.length < MESSAGE_LIMIT; index--) {
    const raw = { ...lines[index], text: lines[index].text.slice(0, LINE_CHARS) };
    const line = index < lines.length - DIET.recent ? diet(raw) : raw;
    const cost = estimateTokens(line.text);
    if (tokens + cost > budget && kept.length) break;
    if (line !== raw) trimmed++;
    kept.unshift(line);
    tokens += cost;
  }
  // `start` counts spoken and typed lines, like the watermark (callers slice the words-only lines with it).
  const start = words - kept.filter((line) => !line.card).length;
  return { start, lines: kept, tokens, trimmed, dropped: start - watermark };
}

/** The replayed lines as the model sees them: text turns plus call turns marked `(on the call)`. */
export function windowMessages(window: HistoryWindow): ModelMessage[] {
  return window.lines.map((line) => ({ role: line.speaker, content: `${line.voice ? '(on the call) ' : ''}${line.text}` }));
}

/**
 * The lines to fold into the rolling summary now, or undefined while the verbatim part is within its roll
 * budget. Never while a call is live: its transcript is still growing in the middle of the list.
 */
export function compactionPlan(state: SessionProjection, env?: Record<string, string | undefined>): { from: number; to: number; lines: Line[] } | undefined {
  if (state.calls.some((call) => call.phase === 'accepted' || call.phase === 'started')) return undefined;
  const budget = compactionBudget(env);
  const lines = conversationLines(state);
  const from = Math.min(state.memory.summary?.lines ?? 0, lines.length);
  const verbatim = lines.slice(from);
  const total = verbatim.reduce((sum, line) => sum + lineTokens(line), 0);
  if (total <= budget.roll && verbatim.length <= budget.rollLines) return undefined;
  let kept = 0;
  let keptTokens = 0;
  while (kept < verbatim.length && kept < budget.keepLines && keptTokens + lineTokens(verbatim[verbatim.length - 1 - kept]) <= budget.keep) {
    keptTokens += lineTokens(verbatim[verbatim.length - 1 - kept]);
    kept++;
  }
  const to = lines.length - Math.max(kept, 2);
  return to - from >= 2 ? { from, to, lines: lines.slice(from, to) } : undefined;
}

/** The assistant line the user's latest words answer (its question before their "yes"), if any. */
export function answeredQuestion(state: SessionProjection): string | undefined {
  const lines = conversationLines(state);
  const lastUser = lines.map((line) => line.speaker).lastIndexOf('user');
  for (let index = lastUser - 1; index >= 0; index--) if (lines[index].speaker === 'assistant') return lines[index].text;
  return undefined;
}

/** The user's own recent words, typed or spoken, newest last. */
export function userWords(state: SessionProjection, limit = 6): string[] {
  return conversationLines(state).filter((line) => line.speaker === 'user').map((line) => line.text).slice(-limit);
}

/** The last few lines as short plain text, for a subagent's small input. */
export function recentLines(lines: Line[], count = 8, max = 300): string[] {
  return lines.slice(-count).map((line) => `${line.speaker}${line.voice ? ' (call)' : ''}: ${line.text.replace(/\s+/g, ' ').slice(0, max)}`);
}
