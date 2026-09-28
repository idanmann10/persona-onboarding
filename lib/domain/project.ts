import type { AgentName, CallEndReason, MemoryKind, MemorySource, Provenance, SessionEvent, Toolkit } from './events';
import { groupUtterances, type Utterance } from '../voice/transcript';
import { setupStatus, type SetupStatus } from './onboarding';
import { memoryIdFor } from './memory';

type FactEvent = Extract<SessionEvent, { type: 'fact' }>;
type FactRecord = Omit<FactEvent, 'evidence'> & { evidence: FactEvent['evidence'] | 'superseded' };
type CallPhase = Extract<SessionEvent, { type: 'call' }>['phase'] | 'idle';
type ConnectionPhase = Extract<SessionEvent, { type: 'connection' }>['phase'];
type MessageEvent = Extract<SessionEvent, { type: 'message' }>;
type Of<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>;

export type SlotStatus = 'unknown' | 'tentative' | 'confirmed' | 'declined';

export interface CallRecord {
  callId: string;
  phase: CallPhase;
  reason?: CallEndReason;
  startedAt?: string;
  endedAt?: string;
  /** The latest time the server heard anything from this call (lifecycle or transcript). */
  lastActivityAt?: string;
  utterances: Utterance[];
}

export type TimelineItem =
  | { kind: 'message'; id: string; speaker: 'user' | 'assistant'; channel: 'text' | 'voice'; text: string; origin?: MessageEvent['origin'] }
  | { kind: 'call'; id: string; call: CallRecord }
  | { kind: 'call_offer'; id: string; status: 'pending' | 'answered' | 'declined' }
  | { kind: 'connection_offer'; id: string; toolkit: Toolkit; status: 'pending' | 'connected' | 'declined' | 'failed'; reason?: string }
  | { kind: 'connection_notice'; id: string; toolkit: Toolkit; phase: 'connected' | 'failed' | 'disconnected'; at?: string }
  | { kind: 'automation'; id: string; automationId: string; title: string; schedule: string; instruction?: string; status: 'proposed' | 'active' | 'declined' | 'disabled'; nextRunAt?: string }
  | { kind: 'automation_notice'; id: string; automationId: string; title: string; phase: 'failed' }
  | { kind: 'settings_notice'; id: string; key: string; value: string }
  | { kind: 'setup_notice'; id: string; phase: 'completed' | 'graduated' };

export interface OnboardingProgress {
  assistantName: { status: SlotStatus; value?: string };
  preferredName: { status: SlotStatus; value?: string };
  need: { status: SlotStatus; value?: string };
  gmail: 'not_offered' | 'offered' | 'declined' | 'connected' | 'failed';
  call: 'not_offered' | 'offered' | 'declined' | 'happened';
  automation: { status: 'none' | 'proposed' | 'active' | 'declined' | 'disabled'; title?: string; schedule?: string };
}

/** One memory as it stands now. A replaced or forgotten memory stays here for the record but is never recalled. */
export interface MemoryRecord {
  memoryId: string;
  text: string;
  kind: MemoryKind;
  labels: string[];
  confidence: 'low' | 'medium' | 'high';
  source: MemorySource;
  provenance: Provenance;
  by: AgentName;
  at: string;
  eventId: string;
  replaces: string[];
  status: 'live' | 'replaced' | 'forgotten';
  replacedBy?: string;
  forgotten?: { reason: string; at: string; by: AgentName };
}

export interface SessionProjection {
  messages: MessageEvent[];
  facts: Record<string, FactRecord>;
  history: FactRecord[];
  call: { phase: CallPhase; callId?: string; reason?: CallEndReason; offerPending: boolean };
  calls: CallRecord[];
  voiceFragments: Extract<SessionEvent, { type: 'voice_fragment' }>[];
  connections: Record<Toolkit, ConnectionPhase | 'none'>;
  /** Apps other than Gmail and Calendar, by slug, from the Apps sheet. */
  apps: Record<string, { name: string; phase: Extract<SessionEvent, { type: 'app_connection' }>['phase'] }>;
  decisions: Record<string, 'messaged' | 'silent'>;
  automations: Array<Extract<TimelineItem, { kind: 'automation' }>>;
  timeline: TimelineItem[];
  onboarding: OnboardingProgress;
  /** The brief's goal: the four things known, or the user skipped ahead. */
  setup: SetupStatus;
  /** What the agents learned and decided along the way (memory, labels, soul notes, follow-ups, check-ins). */
  memory: {
    soulNotes: Record<AgentName, Array<Of<'soul_note'>>>;
    /** Every memory ever saved, oldest first, with its current status (see lib/domain/memory.ts). */
    memories: MemoryRecord[];
    /** Active labels by lowercased label; a `remove` drops one. */
    labels: Record<string, Of<'label'>>;
    /** Loops by id, oldest first; `open` is false once closed. */
    loops: Array<{ loopId: string; text: string; at: string; open: boolean }>;
    summary?: Of<'summary'>;
    /** Conversation lines the memory has already read. */
    readLines: number;
    followUps: Array<Of<'follow_up'>>;
    checkIns: Array<Of<'check_in'>>;
  };
  /** When things happened, for engagement and lifecycle: the first event, returns, and account reads. */
  activity: { firstAt?: string; visits: string[]; reads: Array<Of<'account_read'>>; runs: Array<{ id: string; phase: 'ran' | 'failed'; at: string; title: string }> };
}

const ENDED: CallPhase[] = ['ended', 'dropped'];

export function projectSession(events: SessionEvent[]): SessionProjection {
  const state: SessionProjection = {
    messages: [], facts: {}, history: [], call: { phase: 'idle', offerPending: false }, calls: [], voiceFragments: [],
    connections: { gmail: 'none', calendar: 'none' }, apps: {}, decisions: {}, automations: [], timeline: [], setup: { stage: 'active', open: [] },
    memory: { soulNotes: { assistant: [], memory: [] }, memories: [], labels: {}, loops: [], readLines: 0, followUps: [], checkIns: [] },
    activity: { visits: [], reads: [], runs: [] },
    onboarding: {
      assistantName: { status: 'unknown' }, preferredName: { status: 'unknown' }, need: { status: 'unknown' },
      gmail: 'not_offered', call: 'not_offered', automation: { status: 'none' },
    },
  };
  let graduated = false;
  let completedNoticed = false;
  const seen = new Set<string>();
  const calls = new Map<string, CallRecord>();
  const callFor = (callId: string, id: string) => {
    let record = calls.get(callId);
    if (!record) {
      record = { callId, phase: 'accepted', utterances: [] };
      calls.set(callId, record);
      state.calls.push(record);
      state.timeline.push({ kind: 'call', id, call: record });
    }
    return record;
  };
  let callOffer: Extract<TimelineItem, { kind: 'call_offer' }> | undefined;
  // A card a tool created mid-turn (offer_call, show_connection) belongs after that turn's reply.
  const turnCards = new Map<string, TimelineItem[]>();
  const holdForTurn = (id: string, item: TimelineItem) => {
    const turn = /^call-offer:(.+)$/.exec(id)?.[1] ?? /^connection-offer:(?:gmail|calendar):(.+)$/.exec(id)?.[1] ?? /^automation-proposal:(.+)$/.exec(id)?.[1];
    if (turn) turnCards.set(turn, [...(turnCards.get(turn) ?? []), item]);
  };
  const connectionOffers: Partial<Record<Toolkit, Extract<TimelineItem, { kind: 'connection_offer' }>>> = {};
  const memories = new Map<string, MemoryRecord>();
  const keep = (record: MemoryRecord) => {
    if (memories.has(record.memoryId)) return;
    for (const id of record.replaces) {
      const old = memories.get(id);
      if (old?.status === 'live') { old.status = 'replaced'; old.replacedBy = record.memoryId; }
    }
    memories.set(record.memoryId, record);
    state.memory.memories.push(record);
  };
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    state.activity.firstAt ??= event.at;
    switch (event.type) {
      case 'message': {
        state.messages.push(event);
        state.timeline.push({ kind: 'message', id: event.id, speaker: event.speaker, channel: event.channel, text: event.text, ...(event.origin ? { origin: event.origin } : {}) });
        const cards = event.id.startsWith('answer:') ? turnCards.get(event.id.slice('answer:'.length)) : undefined;
        if (cards) {
          state.timeline = state.timeline.filter((item) => !cards.includes(item));
          state.timeline.push(...cards);
          turnCards.delete(event.id.slice('answer:'.length));
        }
        break;
      }
      case 'fact': {
        const previous = state.facts[event.key];
        if (previous) previous.evidence = 'superseded';
        const current = { ...event };
        state.history.push(current);
        if (event.evidence === 'declined') delete state.facts[event.key];
        else state.facts[event.key] = current;
        // A change the assistant made with customize (or the retired settings menu) gets a line in the thread.
        if (/^(customize|settings):/.test(event.sourceEventId)) state.timeline.push({ kind: 'settings_notice', id: event.id, key: event.key, value: event.value });
        break;
      }
      case 'call': {
        // Once a call has ended nothing reopens it: not a `started` that raced the hang-up, not a second end.
        const earlier = event.callId ? calls.get(event.callId) : undefined;
        if (earlier && ENDED.includes(earlier.phase)) break;
        state.call = { phase: event.phase, callId: event.callId ?? state.call.callId, reason: event.reason, offerPending: event.phase === 'offered' };
        if (event.phase === 'offered') {
          callOffer = { kind: 'call_offer', id: event.id, status: 'pending' };
          state.timeline.push(callOffer);
          holdForTurn(event.id, callOffer);
        } else if (event.phase === 'declined') {
          if (callOffer?.status === 'pending') callOffer.status = 'declined';
        } else if (event.callId) {
          if (callOffer?.status === 'pending') callOffer.status = 'answered';
          const record = callFor(event.callId, event.id);
          if (!ENDED.includes(event.phase)) record.lastActivityAt = event.at;
          record.phase = event.phase;
          if (event.phase === 'started') record.startedAt ??= event.at;
          if (ENDED.includes(event.phase)) { record.endedAt ??= event.at; record.reason ??= event.reason; }
        }
        break;
      }
      case 'voice_fragment':
        state.voiceFragments.push(event);
        if (event.callId) {
          const record = callFor(event.callId, `call:${event.callId}:fragments`);
          if (!ENDED.includes(record.phase)) record.lastActivityAt = event.at;
        }
        break;
      case 'connection': {
        state.connections[event.toolkit] = event.phase;
        if (event.phase === 'offered') {
          const offer: Extract<TimelineItem, { kind: 'connection_offer' }> = { kind: 'connection_offer', id: event.id, toolkit: event.toolkit, status: 'pending', ...(event.reason ? { reason: event.reason } : {}) };
          connectionOffers[event.toolkit] = offer;
          state.timeline.push(offer);
          holdForTurn(event.id, offer);
          break;
        }
        const offer = connectionOffers[event.toolkit];
        if (offer?.status === 'pending' && event.phase !== 'disconnected') offer.status = event.phase;
        if (event.phase !== 'declined') state.timeline.push({ kind: 'connection_notice', id: event.id, toolkit: event.toolkit, phase: event.phase, at: event.at });
        break;
      }
      case 'onboarding':
        if (!graduated && !completedNoticed) state.timeline.push({ kind: 'setup_notice', id: event.id, phase: 'graduated' });
        graduated = true;
        break;
      case 'app_connection':
        // A failed reconnect leaves the earlier connection in place.
        if (event.phase === 'failed' && state.apps[event.app]?.phase === 'connected') break;
        state.apps[event.app] = { name: event.name, phase: event.phase };
        break;
      case 'decision':
        state.decisions[event.trigger] = event.outcome;
        break;
      case 'visit':
        state.activity.visits.push(event.at);
        break;
      case 'account_read':
        state.activity.reads.push(event);
        break;
      case 'soul_note':
        state.memory.soulNotes[event.agent]?.push(event);
        break;
      case 'note':
        keep({
          memoryId: memoryIdFor(event.id), text: event.text, kind: event.kind, labels: [], confidence: event.provenance === 'user_said' ? 'high' : 'medium',
          source: event.source, provenance: event.provenance, by: 'memory', at: event.at, eventId: event.id, replaces: [], status: 'live',
        });
        break;
      case 'memory':
        keep({
          memoryId: event.memoryId, text: event.text, kind: event.kind, labels: event.labels, confidence: event.confidence, source: event.source,
          provenance: event.provenance, by: event.by, at: event.at, eventId: event.id, replaces: event.replaces ?? [], status: 'live',
        });
        break;
      case 'forget': {
        const memory = memories.get(event.memoryId);
        if (memory && memory.status !== 'forgotten') { memory.status = 'forgotten'; memory.forgotten = { reason: event.reason, at: event.at, by: event.by }; }
        break;
      }
      case 'label': {
        const key = event.label.toLocaleLowerCase();
        if (event.action === 'remove') delete state.memory.labels[key];
        else state.memory.labels[key] = event;
        break;
      }
      case 'loop': {
        const loop = state.memory.loops.find((item) => item.loopId === event.loopId);
        if (event.action === 'close') { if (loop) loop.open = false; }
        else if (!loop) state.memory.loops.push({ loopId: event.loopId, text: event.text, at: event.at, open: true });
        break;
      }
      case 'summary':
        if (!state.memory.summary || event.lines >= state.memory.summary.lines) state.memory.summary = event;
        break;
      case 'memory_run':
        state.memory.readLines = Math.max(state.memory.readLines, event.lines);
        break;
      case 'follow_up':
        state.memory.followUps.push(event);
        break;
      case 'check_in':
        state.memory.checkIns.push(event);
        break;
      case 'automation': {
        let card = state.automations.find((item) => item.automationId === event.automationId);
        if (event.phase === 'proposed') {
          if (card) break;
          card = { kind: 'automation', id: event.id, automationId: event.automationId, title: event.title, schedule: event.schedule, ...(event.instruction ? { instruction: event.instruction } : {}), status: 'proposed' };
          state.automations.push(card);
          state.timeline.push(card);
          holdForTurn(event.id, card);
        } else if (card) {
          if (event.phase === 'approved') { card.status = 'active'; card.nextRunAt = event.nextRunAt; }
          else if (event.phase === 'declined' || event.phase === 'disabled') { card.status = event.phase; delete card.nextRunAt; }
          else if (event.phase === 'ran' || event.phase === 'failed') {
            state.activity.runs.push({ id: event.id, phase: event.phase, at: event.at, title: event.title });
            // A run only happens for an approved task, whatever the approval path; a disabled card keeps no schedule.
            if (card.status === 'proposed') card.status = 'active';
            if (card.status === 'active' && event.nextRunAt) card.nextRunAt = event.nextRunAt;
            if (event.phase === 'failed') state.timeline.push({ kind: 'automation_notice', id: event.id, automationId: event.automationId, title: event.title, phase: 'failed' });
          }
        }
        break;
      }
    }
    // The moment the four things are all known (and they didn't skip ahead), setup is done: one line in the thread.
    if (!graduated && !completedNoticed && (event.type === 'fact' || event.type === 'connection') && setupStatus(progress(state)).stage === 'complete') {
      completedNoticed = true;
      state.timeline.push({ kind: 'setup_notice', id: `setup-complete:${event.id}`, phase: 'completed' });
    }
  }
  for (const utterance of groupUtterances(state.voiceFragments)) calls.get(utterance.callId)?.utterances.push(utterance);
  state.onboarding = progress(state);
  state.setup = setupStatus(state.onboarding, { graduated });
  return state;
}

function slot(state: SessionProjection, ...keys: string[]): { status: SlotStatus; value?: string } {
  for (const key of keys) {
    const fact = state.facts[key];
    if (fact) return { status: fact.evidence === 'confirmed' ? 'confirmed' : 'tentative', value: fact.value };
  }
  const last = state.history.filter((fact) => keys.includes(fact.key)).at(-1);
  return last?.evidence === 'declined' ? { status: 'declined' } : { status: 'unknown' };
}

function progress(state: SessionProjection): OnboardingProgress {
  const gmail = state.connections.gmail;
  const lastCallEvent = state.call.phase;
  return {
    assistantName: slot(state, 'assistant_name'),
    preferredName: slot(state, 'preferred_name', 'name'),
    need: slot(state, 'current_need'),
    gmail: gmail === 'connected' ? 'connected' : gmail === 'declined' ? 'declined' : gmail === 'failed' ? 'failed' : gmail === 'offered' ? 'offered' : 'not_offered',
    call: state.calls.some((call) => Boolean(call.startedAt) || call.utterances.length > 0)
      ? 'happened'
      : lastCallEvent === 'declined' ? 'declined' : lastCallEvent === 'offered' ? 'offered' : 'not_offered',
    automation: (() => {
      const latest = state.automations.find((item) => item.status === 'active') ?? state.automations.at(-1);
      return latest ? { status: latest.status, title: latest.title, schedule: latest.schedule } : { status: 'none' as const };
    })(),
  };
}
