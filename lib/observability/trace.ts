import { PROMPT_VERSION } from '../agent/prompts';

/**
 * The agent log: what each turn, step, call and voice tool call did and how long it took, written
 * beside the session so a reviewer can watch the agent work. Tracing is best effort by design: a
 * failed or slow trace write never breaks or delays the reply it describes.
 */
export type TraceKind = 'turn' | 'step' | 'call' | 'voice_tool';
export type TraceStatus = 'running' | 'ok' | 'error' | 'timeout';

export interface TraceEntry {
  turnId: string;
  kind: TraceKind;
  name: string;
  /** ISO time the entry was recorded (the end of a step, the start or end of a turn). */
  at: string;
  durationMs?: number;
  status?: TraceStatus;
  data?: Record<string, unknown>;
}

export interface StoredTrace extends TraceEntry {
  id: number;
}

export interface TraceSink {
  appendTrace(sessionId: string, entry: TraceEntry): Promise<void>;
}

/** What a prepared turn carries so the runtime can describe it. */
export interface TurnTrace {
  sink: TraceSink;
  sessionId: string;
  turnId: string;
  name: string;
  data: Record<string, unknown>;
}

/** A readable, bounded rendering of any value: strings as-is, everything else as JSON. */
export function clip(value: unknown, max = 600): string {
  if (value === undefined || value === null) return '';
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value) ?? String(value); } catch { text = String(value); }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The label a reviewer sees for a turn, from what woke the assistant. */
export function turnName(triggerId?: string): string {
  if (!triggerId) return 'Reply';
  if (triggerId.startsWith('followup:call:')) return 'Follow-up after the call';
  if (triggerId.startsWith('followup:connection:')) return 'Follow-up after connecting';
  if (triggerId.startsWith('followup:visit:')) return 'Welcome back';
  if (triggerId.startsWith('followup:check-in:')) return 'Scheduled check-in';
  if (triggerId.startsWith('followup:task:')) return 'Follow-up after a task';
  if (triggerId.startsWith('followup:')) return 'Follow-up';
  if (triggerId.startsWith('automation:')) return 'Recurring task';
  return 'Reply';
}

/** A tool output reduced to its status and a short preview. */
export function outputSummary(output: unknown): { status?: string; preview: string } {
  let value = output;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { /* plain text output */ }
  }
  const status = value && typeof value === 'object' && 'status' in value ? String((value as { status: unknown }).status) : undefined;
  // The full result, bounded: the agent log is where people check exactly what a tool returned.
  return { ...(status ? { status } : {}), preview: clip(value, 6_000) };
}

/** Collects trace writes without awaiting them; `flush` waits for all of them and never throws. */
export function traceWriter(sink: TraceSink | undefined, sessionId: string) {
  // One queue, in call order: concurrent inserts let a turn's last step land after its end entry, and the
  // log then showed that step as a second, never-finished turn. The queue runs in the background, so the
  // model is still never waiting on a trace write.
  let queue: Promise<void> = Promise.resolve();
  return {
    record(entry: TraceEntry): void {
      if (!sink) return;
      queue = queue.then(async () => {
        try { await sink.appendTrace(sessionId, entry); }
        catch (error) { console.warn('Trace write failed', error instanceof Error ? error.message : error); }
      });
    },
    async flush(): Promise<void> {
      await queue;
    },
  };
}

/** Record one entry and wait for it, swallowing any failure. */
export async function recordTrace(sink: Partial<TraceSink> | undefined, sessionId: string, entry: TraceEntry): Promise<void> {
  if (!sink?.appendTrace) return;
  try { await sink.appendTrace(sessionId, entry); } catch (error) { console.warn('Trace write failed', error instanceof Error ? error.message : error); }
}

export const isTraceSink = (value: unknown): value is TraceSink =>
  Boolean(value) && typeof (value as Partial<TraceSink>).appendTrace === 'function';

/** The start-of-turn description: which model, which prompt, what it saw and could do. */
export function describeTurn(sink: TraceSink, sessionId: string, turn: {
  turnId: string; trigger?: { id: string; instruction: string }; channel: string; model?: string;
  instructions: string; messages: unknown[]; tools: Record<string, unknown>; userText?: string;
}): TurnTrace {
  return {
    sink, sessionId, turnId: turn.turnId, name: turnName(turn.trigger?.id),
    data: {
      model: turn.model ?? 'unknown',
      promptVersion: PROMPT_VERSION,
      instructions: turn.instructions,
      messageCount: turn.messages.length,
      tools: Object.keys(turn.tools),
      channel: turn.channel,
      ...(turn.trigger ? { triggerId: turn.trigger.id, trigger: clip(turn.trigger.instruction, 2_000) } : turn.userText ? { userText: clip(turn.userText, 1_200) } : {}),
    },
  };
}
