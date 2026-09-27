import { describe, expect, it } from 'vitest';
import { projectSession } from '../../lib/domain/project';
import type { SessionEvent } from '../../lib/domain/events';

const at = '2026-09-27T12:00:00.000Z';
const message = (id: string, text: string): SessionEvent => ({ id, at, type: 'message', speaker: 'user', channel: 'text', text });

describe('projectSession', () => {
  it('preserves a direct task without requiring a name', () => {
    const state = projectSession([message('m1', 'Help me prepare for my board meeting')]);
    expect(state.messages[0].text).toContain('board meeting');
    expect(state.facts.preferred_name).toBeUndefined();
  });

  it('lets a correction supersede a previous name', () => {
    const state = projectSession([
      { id: 'f1', at, type: 'fact', key: 'preferred_name', value: 'Samantha', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm1' },
      { id: 'f2', at, type: 'fact', key: 'preferred_name', value: 'Sam', evidence: 'confirmed', provenance: 'user_confirmed', sourceEventId: 'm2' },
    ]);
    expect(state.facts.preferred_name?.value).toBe('Sam');
    expect(state.history.find((fact) => fact.value === 'Samantha')?.evidence).toBe('superseded');
  });

  it('keeps a declined call closed until the user explicitly accepts', () => {
    const state = projectSession([
      { id: 'c1', at, type: 'call', phase: 'offered' },
      { id: 'c2', at, type: 'call', phase: 'declined' },
      message('m1', 'Tell me about my week'),
    ]);
    expect(state.call.phase).toBe('declined');
  });

  it('keeps partial voice words without promoting them to confirmed facts after hangup', () => {
    const state = projectSession([
      { id: 'c1', at, type: 'call', phase: 'started' },
      { id: 'v1', at, type: 'voice_fragment', text: 'I maybe work at North...', final: false },
      { id: 'c2', at, type: 'call', phase: 'ended' },
    ]);
    expect(state.voiceFragments).toHaveLength(1);
    expect(state.voiceFragments[0].final).toBe(false);
    expect(state.facts.company).toBeUndefined();
    expect(state.call.phase).toBe('ended');
  });

  it('ignores a repeated event ID and replays deterministically', () => {
    const events = [message('m1', 'hello'), message('m1', 'hello')];
    const state = projectSession(events);
    expect(state.messages).toHaveLength(1);
    expect(projectSession(events)).toEqual(state);
  });
});
