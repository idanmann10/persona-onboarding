import type { SessionEvent } from './events';

type FactEvent = Extract<SessionEvent, { type: 'fact' }>;
type FactRecord = Omit<FactEvent, 'evidence'> & { evidence: FactEvent['evidence'] | 'superseded' };
type CallPhase = Extract<SessionEvent, { type: 'call' }>['phase'] | 'idle';

export interface SessionProjection {
  messages: Extract<SessionEvent, { type: 'message' }>[];
  facts: Record<string, FactRecord>;
  history: FactRecord[];
  call: { phase: CallPhase };
  voiceFragments: Extract<SessionEvent, { type: 'voice_fragment' }>[];
}

export function projectSession(events: SessionEvent[]): SessionProjection {
  const state: SessionProjection = {
    messages: [], facts: {}, history: [], call: { phase: 'idle' }, voiceFragments: [],
  };
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    switch (event.type) {
      case 'message':
        state.messages.push(event);
        break;
      case 'fact': {
        const previous = state.facts[event.key];
        if (previous) previous.evidence = 'superseded';
        const current = { ...event };
        state.history.push(current);
        if (event.evidence === 'declined') delete state.facts[event.key];
        else state.facts[event.key] = current;
        break;
      }
      case 'call':
        state.call = { phase: event.phase };
        break;
      case 'voice_fragment':
        state.voiceFragments.push(event);
        break;
    }
  }
  return state;
}
