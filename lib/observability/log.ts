import type { SessionEvent } from '../domain/events';
import { memoryIdFor } from '../domain/memory';
import type { SessionProjection } from '../domain/project';
import type { StoredTrace, TraceStatus } from './trace';

export interface ToolView { name: string; input: string; status: string; preview?: string; ms?: number }

export interface StepView {
  index: number;
  name: string;
  status: TraceStatus;
  /** Where the step began, in ms after the turn started. */
  offsetMs: number;
  durationMs: number;
  modelMs: number;
  toolMs: number;
  finishReason?: string;
  tokensIn: number;
  cachedIn: number;
  tokensOut: number;
  reasoningTokens: number;
  text?: string;
  tools: ToolView[];
}

export interface TurnItem {
  kind: 'turn';
  id: string;
  turnId: string;
  name: string;
  at: string;
  status: TraceStatus;
  durationMs?: number;
  firstTokenMs?: number;
  model?: string;
  promptVersion?: string;
  instructions?: string;
  messageCount?: number;
  /** Estimated tokens per prompt section and what the replayed conversation held (see lib/agent/budget.ts). */
  context?: Record<string, number | string>;
  toolsOffered: string[];
  userText?: string;
  trigger?: string;
  /** Set for a background agent's run (the onboarding coach, the memory); its reply is its JSON decision. */
  agent?: string;
  reply?: string;
  error?: string;
  stalls: number;
  steps: StepView[];
  totals: { toolCalls: number; tokensIn: number; cachedIn: number; tokensOut: number; reasoningTokens: number };
}

export interface CallItem {
  kind: 'call';
  id: string;
  callId: string;
  at: string;
  startedAt?: string;
  endedAt?: string;
  reason?: string;
  phase: string;
  durationMs?: number;
  setup?: { ms?: number; status: TraceStatus; voice?: string; model?: string; delegation?: string; instructionsChars?: number; seededMessages?: number; error?: string };
  utterances: Array<{ speaker: 'user' | 'assistant'; text: string }>;
  tools: Array<ToolView & { at: string }>;
}

export interface EventItem {
  kind: 'event';
  id: string;
  at: string;
  tone: 'good' | 'bad' | 'neutral';
  label: string;
  detail?: string;
  tag?: string;
}

export type LogItem = TurnItem | CallItem | EventItem;

export interface LogSummary {
  turns: number;
  medianMs?: number;
  p95Ms?: number;
  medianFirstTokenMs?: number;
  steps: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  cachedPercent?: number;
  calls: number;
  errors: number;
}

/** A turn with no end entry after this long died with its process; it is not still running. */
const STALE_MS = 5 * 60_000;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function toolViews(value: unknown): ToolView[] {
  if (!Array.isArray(value)) return [];
  return value.map((tool) => {
    const item = (tool ?? {}) as Record<string, unknown>;
    return { name: str(item.name) ?? 'tool', input: str(item.input) ?? '', status: str(item.status) ?? 'done', ...(str(item.preview) ? { preview: str(item.preview) } : {}), ...(typeof item.ms === 'number' ? { ms: Math.round(item.ms) } : {}) };
  });
}

/** Turns from their start, step and end entries. A turn id that runs again opens a new turn. */
export function groupTurns(traces: StoredTrace[], now = Date.now()): TurnItem[] {
  const turns: TurnItem[] = [];
  const open = new Map<string, { item: TurnItem; startedAt: number }>();
  // The latest turn for each id, finished or not: a step written just after its turn's end still belongs to it.
  const latest = new Map<string, { item: TurnItem; startedAt: number }>();
  const openTurn = (entry: StoredTrace) => {
    const data = entry.data ?? {};
    const item: TurnItem = {
      kind: 'turn', id: `turn:${entry.id}`, turnId: entry.turnId, name: entry.name, at: entry.at, status: 'running',
      model: str(data.model), promptVersion: str(data.promptVersion), instructions: str(data.instructions),
      messageCount: typeof data.messageCount === 'number' ? data.messageCount : undefined,
      ...(data.context && typeof data.context === 'object' ? { context: data.context as Record<string, number | string> } : {}),
      toolsOffered: Array.isArray(data.tools) ? data.tools.filter((name): name is string => typeof name === 'string') : [],
      userText: str(data.userText), trigger: str(data.trigger), ...(str(data.agent) ? { agent: str(data.agent) } : {}), stalls: 0, steps: [],
      totals: { toolCalls: 0, tokensIn: 0, cachedIn: 0, tokensOut: 0, reasoningTokens: 0 },
    };
    turns.push(item);
    const record = { item, startedAt: Date.parse(entry.at) };
    open.set(entry.turnId, record);
    latest.set(entry.turnId, record);
    return record;
  };
  for (const entry of traces) {
    if (entry.kind !== 'turn' && entry.kind !== 'step') continue;
    if (entry.kind === 'turn' && entry.status === 'running') { openTurn(entry); continue; }
    // An entry without its start (the start write failed) still gets a turn to belong to.
    const current = open.get(entry.turnId) ?? (entry.kind === 'step' ? latest.get(entry.turnId) : undefined)
      ?? openTurn({ ...entry, at: new Date(Date.parse(entry.at) - num(entry.durationMs)).toISOString(), data: {} });
    const { item, startedAt } = current;
    const data = entry.data ?? {};
    if (entry.kind === 'step') {
      const durationMs = num(entry.durationMs);
      if (entry.status === 'timeout') item.stalls++;
      const tools = toolViews(data.tools);
      const end = Date.parse(entry.at) - startedAt;
      const step: StepView = {
        index: item.steps.length + 1, name: entry.name, status: entry.status ?? 'ok',
        offsetMs: entry.status === 'timeout' ? 0 : Math.max(0, end - durationMs), durationMs,
        modelMs: entry.status === 'timeout' ? durationMs : num(data.modelMs), toolMs: num(data.toolMs),
        finishReason: str(data.finishReason), tokensIn: num(data.tokensIn), cachedIn: num(data.cachedIn), tokensOut: num(data.tokensOut),
        reasoningTokens: num(data.reasoningTokens), text: str(data.text), tools,
      };
      item.steps.push(step);
      item.totals.toolCalls += tools.length;
      item.totals.tokensIn += step.tokensIn;
      item.totals.cachedIn += step.cachedIn;
      item.totals.tokensOut += step.tokensOut;
      item.totals.reasoningTokens += step.reasoningTokens;
      continue;
    }
    item.status = entry.status ?? 'ok';
    item.durationMs = entry.durationMs;
    if (typeof data.firstTokenMs === 'number') item.firstTokenMs = Math.round(data.firstTokenMs);
    item.reply = typeof data.reply === 'string' ? data.reply : undefined;
    item.error = str(data.error);
    open.delete(entry.turnId);
  }
  for (const { item, startedAt } of open.values()) {
    if (now - startedAt > STALE_MS) { item.status = 'error'; item.error ??= 'No end was recorded (the server stopped mid-turn)'; }
  }
  return turns;
}

function callItems(state: SessionProjection, traces: StoredTrace[]): CallItem[] {
  const items = new Map<string, CallItem>();
  for (const call of state.calls) {
    const at = call.startedAt ?? call.lastActivityAt ?? call.endedAt ?? '';
    items.set(call.callId, {
      kind: 'call', id: `call:${call.callId}`, callId: call.callId, at, phase: call.phase,
      ...(call.startedAt ? { startedAt: call.startedAt } : {}), ...(call.endedAt ? { endedAt: call.endedAt } : {}), ...(call.reason ? { reason: call.reason } : {}),
      ...(call.startedAt && call.endedAt ? { durationMs: Math.max(0, Date.parse(call.endedAt) - Date.parse(call.startedAt)) } : {}),
      utterances: call.utterances.map((utterance) => ({ speaker: utterance.speaker, text: utterance.text })), tools: [],
    });
  }
  for (const entry of traces) {
    if (entry.kind !== 'call' && entry.kind !== 'voice_tool') continue;
    let item = items.get(entry.turnId);
    if (!item) {
      item = { kind: 'call', id: `call:${entry.turnId}`, callId: entry.turnId, at: entry.at, phase: entry.status === 'error' ? 'setup_failed' : 'accepted', utterances: [], tools: [] };
      items.set(entry.turnId, item);
    }
    const data = entry.data ?? {};
    if (entry.kind === 'call') {
      item.setup = {
        ...(entry.durationMs === undefined ? {} : { ms: entry.durationMs }), status: entry.status ?? 'ok',
        voice: str(data.voice), model: str(data.model), delegation: str(data.delegation),
        instructionsChars: typeof data.instructionsChars === 'number' ? data.instructionsChars : undefined,
        seededMessages: typeof data.seededMessages === 'number' ? data.seededMessages : undefined, error: str(data.error),
      };
      // The setup happens before the call starts; the card sits where the setup began.
      if (!item.at || entry.at < item.at) item.at = entry.at;
    } else {
      item.tools.push({ name: entry.name, input: str(data.input) ?? '', status: str(data.status) ?? entry.status ?? 'done', ...(str(data.preview) ? { preview: str(data.preview) } : {}), ...(entry.durationMs === undefined ? {} : { ms: entry.durationMs }), at: entry.at });
    }
  }
  return [...items.values()];
}

const TOOLKIT = { gmail: 'Gmail', calendar: 'Google Calendar' } as const;
const FACT_LABELS: Record<string, string> = { assistant_name: 'Assistant name', preferred_name: 'User name', name: 'User name', current_need: 'Need', personality: 'Personality', voice: 'Voice' };
const AGENT_NAMES = { assistant: 'Assistant', coach: 'Coach', memory: 'Memory' } as const;

/** Moments a reviewer cares about: accounts, call offers, recurring tasks, saved facts, and what the agents learned and decided. */
export function notableEvents(events: SessionEvent[]): EventItem[] {
  const items: EventItem[] = [];
  const seen = new Set<string>();
  // What each memory said, so a merge, a correction or a forget can show what it replaced.
  const memories = new Map<string, string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const base = { id: `event:${event.id}`, at: event.at };
    if (event.type === 'connection') {
      const name = TOOLKIT[event.toolkit];
      const labels = { offered: [`${name} connect button shown`, 'neutral'], declined: [`${name} declined`, 'neutral'], connected: [`${name} connected`, 'good'], failed: [`${name} connection failed`, 'bad'], disconnected: [`${name} disconnected`, 'neutral'] } as const;
      const [label, tone] = labels[event.phase];
      items.push({ ...base, kind: 'event', tone, label, ...(event.reason ? { detail: event.reason } : {}) });
    } else if (event.type === 'call' && (event.phase === 'offered' || event.phase === 'declined')) {
      items.push({ ...base, kind: 'event', tone: 'neutral', label: event.phase === 'offered' ? 'Call offered' : 'Call declined' });
    } else if (event.type === 'automation') {
      const labels = { proposed: ['Recurring task proposed', 'neutral'], approved: ['Recurring task approved', 'good'], declined: ['Recurring task declined', 'neutral'], disabled: ['Recurring task turned off', 'neutral'], ran: ['Recurring task ran', 'good'], failed: ['Recurring task failed', 'bad'] } as const;
      const [label, tone] = labels[event.phase];
      items.push({ ...base, kind: 'event', tone, label, detail: `${event.title} · ${event.schedule}` });
    } else if (event.type === 'fact') {
      const label = FACT_LABELS[event.key] ?? event.key.replace(/_/g, ' ');
      items.push({
        ...base, kind: 'event', tone: event.evidence === 'declined' ? 'neutral' : 'good',
        label: event.id.includes(':forget:') ? `Forgot ${label.toLowerCase()}` : event.evidence === 'declined' ? `${label}: declined to share` : `Saved ${label.toLowerCase()}`,
        ...(event.evidence === 'declined' ? {} : { detail: event.value }), tag: event.provenance.replace(/_/g, ' '),
      });
    } else if (event.type === 'account_read') {
      items.push({ ...base, kind: 'event', tone: 'neutral', label: `Read ${TOOLKIT[event.toolkit]}`, detail: `${event.items} item${event.items === 1 ? '' : 's'}` });
    } else if (event.type === 'soul_note') {
      items.push({ ...base, kind: 'event', tone: 'good', label: `${AGENT_NAMES[event.agent]} added to its soul`, detail: event.text, tag: 'soul note' });
    } else if (event.type === 'label') {
      items.push({ ...base, kind: 'event', tone: 'neutral', label: `Label ${event.action === 'add' ? 'added' : 'removed'}: ${event.label}`, detail: `${event.confidence} confidence · ${event.evidence}`, tag: event.provenance.replace(/_/g, ' ') });
    } else if (event.type === 'note') {
      memories.set(memoryIdFor(event.id), event.text);
      items.push({ ...base, kind: 'event', tone: 'neutral', label: `Memory kept a ${event.kind}`, detail: event.text, tag: `from ${event.source}` });
    } else if (event.type === 'memory') {
      const replaced = (event.replaces ?? []).map((id) => memories.get(id) ?? id);
      memories.set(event.memoryId, event.text);
      const who = AGENT_NAMES[event.by];
      const label = replaced.length > 1 ? `${who} merged ${replaced.length} memories` : replaced.length ? `${who} corrected a memory` : `${who} saved a memory`;
      items.push({
        ...base, kind: 'event', tone: 'good', label,
        detail: `${event.text}\n${[event.kind, ...event.labels].join(', ')} · ${event.confidence} confidence · [${event.memoryId}]${replaced.length ? `\nReplaces: ${replaced.join(' | ')}` : ''}`,
        tag: `from ${event.source}`,
      });
    } else if (event.type === 'forget') {
      items.push({ ...base, kind: 'event', tone: 'neutral', label: `${AGENT_NAMES[event.by]} forgot a memory`, detail: `${memories.get(event.memoryId) ?? event.memoryId}\nWhy: ${event.reason}`, tag: event.memoryId });
    } else if (event.type === 'loop') {
      items.push({ ...base, kind: 'event', tone: 'neutral', label: event.action === 'open' ? 'Open loop' : 'Loop closed', detail: event.text });
    } else if (event.type === 'summary') {
      const scrub = event.id.includes(':scrub:');
      items.push({ ...base, kind: 'event', tone: 'neutral', label: scrub ? 'Summary rewritten without what they asked to forget' : `Conversation compacted: the first ${event.lines} lines are now a summary`, detail: event.text, tag: 'compaction' });
    } else if (event.type === 'coach') {
      const decision = event.reachOut === 'now' ? 'reach out now' : event.reachOut === 'later' ? `check in at ${event.wakeAt?.slice(11, 16) ?? '?'} UTC` : 'stay quiet';
      items.push({ ...base, kind: 'event', tone: 'neutral', label: `Coach: ${decision} · focus ${event.focus.replace(/_/g, ' ')}`, detail: `${event.why}\n${event.guidance}${event.guard ? `\nGuardrail: ${event.guard}` : ''}`, tag: event.trigger.split(':')[0] });
    } else if (event.type === 'setup_ask') {
      items.push({ ...base, kind: 'event', tone: 'neutral', label: `Asked about ${event.item.replace(/_/g, ' ')}` });
    }
  }
  return items;
}

export function summarize(all: TurnItem[], calls: CallItem[]): LogSummary {
  // Background agents run after the reply; they are not replies, so they stay out of the reply numbers.
  const turns = all.filter((turn) => !turn.agent);
  const done = turns.filter((turn) => turn.status !== 'running' && typeof turn.durationMs === 'number');
  const durations = done.map((turn) => turn.durationMs!);
  const firstTokens = turns.map((turn) => turn.firstTokenMs).filter((ms): ms is number => typeof ms === 'number');
  const tokensIn = turns.reduce((sum, turn) => sum + turn.totals.tokensIn, 0);
  const cached = turns.reduce((sum, turn) => sum + turn.totals.cachedIn, 0);
  return {
    turns: turns.length,
    medianMs: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    medianFirstTokenMs: percentile(firstTokens, 50),
    steps: turns.reduce((sum, turn) => sum + turn.steps.filter((step) => step.status !== 'timeout').length, 0),
    toolCalls: turns.reduce((sum, turn) => sum + turn.totals.toolCalls, 0) + calls.reduce((sum, call) => sum + call.tools.length, 0),
    tokensIn,
    tokensOut: turns.reduce((sum, turn) => sum + turn.totals.tokensOut, 0),
    cachedPercent: tokensIn ? Math.round((cached / tokensIn) * 100) : undefined,
    calls: calls.filter((call) => call.startedAt || call.utterances.length || call.setup?.status === 'ok').length,
    errors: turns.filter((turn) => turn.status === 'error' || turn.status === 'timeout').length + calls.filter((call) => call.setup?.status === 'error').length,
  };
}

/** Everything the agent log shows, oldest first. */
export function buildAgentLog(state: SessionProjection, events: SessionEvent[], traces: StoredTrace[], now = Date.now()) {
  const turns = groupTurns(traces, now);
  const calls = callItems(state, traces);
  const items: LogItem[] = [...turns, ...calls, ...notableEvents(events)]
    .map((item, order) => ({ item, order }))
    .sort((a, b) => (Date.parse(a.item.at) || 0) - (Date.parse(b.item.at) || 0) || a.order - b.order)
    .map(({ item }) => item);
  return { summary: summarize(turns, calls), items };
}
