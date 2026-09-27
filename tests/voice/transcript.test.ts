import { describe, expect, it } from 'vitest';
import { groupUtterances } from '../../lib/voice/transcript';
import type { SessionEvent } from '../../lib/domain/events';

type Fragment = Extract<SessionEvent, { type: 'voice_fragment' }>;
const at = '2026-09-27T12:00:00.000Z';
let n = 0;
const fragment = (speaker: 'user' | 'assistant', text: string, startMs: number, callId = 'live_a'): Fragment =>
  ({ id: `v${++n}`, at, type: 'voice_fragment', callId, speaker, text, startMs, endMs: startMs + 200, final: false });

describe('call transcript grouping', () => {
  it('joins one speaker run in timeline order, preserving the fragments exactly', () => {
    const utterances = groupUtterances([
      fragment('assistant', "Hey, it's Max.", 0),
      fragment('user', 'Hi Max', 1_000),
      fragment('user', ", I'm Dana.", 1_300),
      fragment('assistant', 'Nice to meet you, Dana.', 2_000),
    ]);
    expect(utterances.map((utterance) => [utterance.speaker, utterance.text])).toEqual([
      ['assistant', "Hey, it's Max."], ['user', "Hi Max, I'm Dana."], ['assistant', 'Nice to meet you, Dana.'],
    ]);
  });

  it('orders by timeline, not arrival, and keeps calls apart', () => {
    const utterances = groupUtterances([
      fragment('user', ' second', 600), fragment('user', 'first', 100), fragment('assistant', 'other call', 0, 'live_b'),
    ]);
    expect(utterances).toEqual([
      expect.objectContaining({ callId: 'live_a', speaker: 'user', text: 'first second' }),
      expect.objectContaining({ callId: 'live_b', speaker: 'assistant', text: 'other call' }),
    ]);
  });

  it('folds a backchannel inside the caller\'s run into one bubble', () => {
    const utterances = groupUtterances([
      fragment('user', 'So every month I have to', 0),
      fragment('assistant', 'mm-hmm', 900),
      fragment('user', ' write the investor update', 1_200),
    ]);
    expect(utterances).toEqual([expect.objectContaining({ speaker: 'user', text: 'So every month I have to write the investor update' })]);
  });

  it('keeps a real reply between two caller turns', () => {
    const utterances = groupUtterances([
      fragment('user', 'Can you check my inbox?', 0), fragment('assistant', 'Sure, one moment.', 900), fragment('user', 'Thanks', 3_000),
    ]);
    expect(utterances).toHaveLength(3);
  });
});
