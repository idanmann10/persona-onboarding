import { describe, expect, it } from 'vitest';
import { parseLiveEvent } from '../../lib/voice/events';

describe('GPT-Live event parsing', () => {
  it('preserves transcript fragments and timing without treating one as a completed turn', () => {
    expect(parseLiveEvent({ type: 'session.input_transcript.delta', event_id: 'evt-1', delta: ' to Friday', start_ms: 200, end_ms: 500 })).toEqual({ kind: 'transcript', eventId: 'evt-1', speaker: 'user', text: ' to Friday', startMs: 200, endMs: 500 });
  });
  it('recognizes start and final close separately from transport loss', () => {
    expect(parseLiveEvent({ type: 'session.started' })).toEqual({ kind: 'started' });
    expect(parseLiveEvent({ type: 'session.closed', reason: 'close_requested' })).toEqual({ kind: 'ended' });
    expect(parseLiveEvent({ type: 'session.output_transcript.delta', delta: 'hi' })).toBeNull();
  });
});
