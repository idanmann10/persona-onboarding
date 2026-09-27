import type { CallEndReason, SessionEvent, Toolkit } from './events';
import { groupUtterances, type Utterance } from '../voice/transcript';

type FactEvent = Extract<SessionEvent, { type: 'fact' }>;
type FactRecord = Omit<FactEvent, 'evidence'> & { evidence: FactEvent['evidence'] | 'superseded' };
type CallPhase = Extract<SessionEvent, { type: 'call' }>['phase'] | 'idle';
type ConnectionPhase = Extract<SessionEvent, { type: 'connection' }>['phase'];
type MessageEvent = Extract<SessionEvent, { type: 'message' }>;

export type SlotStatus = 'unknown' | 'tentative' | 'confirmed' | 'declined';

export interface CallRecord {
  callId: string;
  phase: CallPhase;
  reason?: CallEndReason;
  startedAt?: string;
  endedAt?: string;
  utterances: Utterance[];
}

export type TimelineItem =
  | { kind: 'message'; id: string; speaker: 'user' | 'assistant'; channel: 'text' | 'voice'; text: string; origin?: MessageEvent['origin'] }
  | { kind: 'call'; id: string; call: CallRecord }
  | { kind: 'call_offer'; id: string; status: 'pending' | 'answered' | 'declined' }
  | { kind: 'connection_offer'; id: string; toolkit: Toolkit; status: 'pending' | 'connected' | 'declined' | 'failed'; reason?: string }
  | { kind: 'connection_notice'; id: string; toolkit: Toolkit; phase: 'connected' | 'failed' | 'disconnected' };

export interface OnboardingProgress {
  assistantName: { status: SlotStatus; value?: string };
  preferredName: { status: SlotStatus; value?: string };
  need: { status: SlotStatus; value?: string };
  gmail: 'not_offered' | 'offered' | 'declined' | 'connected' | 'failed';
  call: 'not_offered' | 'offered' | 'declined' | 'happened';
}

export interface SessionProjection {
  messages: MessageEvent[];
  facts: Record<string, FactRecord>;
  history: FactRecord[];
  call: { phase: CallPhase; callId?: string; reason?: CallEndReason; offerPending: boolean };
  calls: CallRecord[];
  voiceFragments: Extract<SessionEvent, { type: 'voice_fragment' }>[];
  connections: Record<Toolkit, ConnectionPhase | 'none'>;
  decisions: Record<string, 'messaged' | 'silent'>;
  timeline: TimelineItem[];
  onboarding: OnboardingProgress;
}

const ENDED: CallPhase[] = ['ended', 'dropped'];

export function projectSession(events: SessionEvent[]): SessionProjection {
  const state: SessionProjection = {
    messages: [], facts: {}, history: [], call: { phase: 'idle', offerPending: false }, calls: [], voiceFragments: [],
    connections: { gmail: 'none', calendar: 'none' }, decisions: {}, timeline: [],
    onboarding: {
      assistantName: { status: 'unknown' }, preferredName: { status: 'unknown' }, need: { status: 'unknown' },
      gmail: 'not_offered', call: 'not_offered',
    },
  };
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
    const turn = /^call-offer:(.+)$/.exec(id)?.[1] ?? /^connection-offer:(?:gmail|calendar):(.+)$/.exec(id)?.[1];
    if (turn) turnCards.set(turn, [...(turnCards.get(turn) ?? []), item]);
  };
  const connectionOffers: Partial<Record<Toolkit, Extract<TimelineItem, { kind: 'connection_offer' }>>> = {};
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
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
        break;
      }
      case 'call': {
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
          record.phase = event.phase;
          if (event.phase === 'started') record.startedAt ??= event.at;
          if (ENDED.includes(event.phase)) { record.endedAt ??= event.at; record.reason ??= event.reason; }
        }
        break;
      }
      case 'voice_fragment':
        state.voiceFragments.push(event);
        if (event.callId) callFor(event.callId, `call:${event.callId}:fragments`);
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
        if (event.phase !== 'declined') state.timeline.push({ kind: 'connection_notice', id: event.id, toolkit: event.toolkit, phase: event.phase });
        break;
      }
      case 'decision':
        state.decisions[event.trigger] = event.outcome;
        break;
    }
  }
  for (const utterance of groupUtterances(state.voiceFragments)) calls.get(utterance.callId)?.utterances.push(utterance);
  state.onboarding = progress(state);
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
  };
}
