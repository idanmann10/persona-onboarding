export type ParsedLiveEvent =
  | { kind: 'started' }
  | { kind: 'ended' | 'dropped' }
  | { kind: 'transcript'; eventId: string; speaker: 'user' | 'assistant'; text: string; startMs: number; endMs: number };

export function parseLiveEvent(event: unknown): ParsedLiveEvent | null {
  if (!event || typeof event !== 'object') return null;
  const value = event as Record<string, unknown>;
  if (value.type === 'session.started') return { kind: 'started' };
  if (value.type === 'session.closed') return { kind: value.reason === 'connection_lost' ? 'dropped' : 'ended' };
  if (value.type !== 'session.input_transcript.delta' && value.type !== 'session.output_transcript.delta') return null;
  if (typeof value.event_id !== 'string' || typeof value.delta !== 'string' ||
      typeof value.start_ms !== 'number' || typeof value.end_ms !== 'number') return null;
  return { kind: 'transcript', eventId: value.event_id, speaker: value.type === 'session.input_transcript.delta' ? 'user' : 'assistant', text: value.delta, startMs: value.start_ms, endMs: value.end_ms };
}
