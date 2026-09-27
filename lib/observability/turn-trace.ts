import type { StepResult, ToolSet } from 'ai';
import { clip, outputSummary, traceWriter, type TraceStatus, type TurnTrace } from './trace';

/**
 * Records one turn: a start entry, one entry per finished model step, one per stall that triggered
 * the retry, and an end entry with the totals. Every write is collected and settled at `end`; none is
 * awaited while the model is working.
 */
export function turnTracer(trace: TurnTrace | undefined) {
  const writer = traceWriter(trace?.sink, trace?.sessionId ?? '');
  const started = Date.now();
  const totals = { steps: 0, toolCalls: 0, tokensIn: 0, cachedIn: 0, tokensOut: 0, reasoningTokens: 0 };
  let stepIndex = 0;
  const record = (kind: 'turn' | 'step', name: string, fields: { status?: TraceStatus; durationMs?: number; data?: Record<string, unknown> }) => {
    if (!trace) return;
    writer.record({ turnId: trace.turnId, kind, name, at: new Date().toISOString(), ...fields });
  };
  return {
    start(): void {
      if (!trace) return;
      record('turn', trace.name, { status: 'running', data: trace.data });
    },
    /** For `onStepEnd`: synchronous, so it never holds up the stream. */
    step(step: StepResult<ToolSet>): void {
      if (!trace) return;
      try {
        stepIndex++;
        const tools = step.toolCalls.map((call) => {
          const result = step.toolResults.find((item) => item.toolCallId === call.toolCallId);
          const summary = result ? outputSummary(result.output) : { status: 'no_result', preview: '' };
          return { name: call.toolName, input: clip(call.input, 240), status: summary.status ?? 'done', preview: summary.preview, ms: step.performance?.toolExecutionMs?.[call.toolCallId] };
        });
        const usage = step.usage;
        const tokensIn = usage?.inputTokens ?? 0;
        const cachedIn = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
        const tokensOut = usage?.outputTokens ?? 0;
        const reasoningTokens = usage?.outputTokenDetails?.reasoningTokens ?? 0;
        totals.steps++;
        totals.toolCalls += tools.length;
        totals.tokensIn += tokensIn;
        totals.cachedIn += cachedIn;
        totals.tokensOut += tokensOut;
        totals.reasoningTokens += reasoningTokens;
        const toolMs = Object.values(step.performance?.toolExecutionMs ?? {}).reduce((sum, ms) => sum + (Number(ms) || 0), 0);
        record('step', `Step ${stepIndex}`, {
          status: 'ok',
          durationMs: Math.round(step.performance?.stepTimeMs ?? 0),
          data: {
            index: stepIndex,
            modelMs: Math.round(step.performance?.responseTimeMs ?? 0),
            toolMs: Math.round(toolMs),
            firstOutputMs: step.performance?.timeToFirstOutputMs === undefined ? undefined : Math.round(step.performance.timeToFirstOutputMs),
            finishReason: step.finishReason,
            tokensIn, cachedIn, tokensOut, reasoningTokens,
            text: clip(step.text, 1_200),
            tools,
          },
        });
      } catch (error) {
        console.warn('Trace step failed', error instanceof Error ? error.message : error);
      }
    },
    stalled(attempt: number): void {
      record('step', 'Stalled, retrying', { status: 'timeout', durationMs: Date.now() - started, data: { attempt } });
    },
    async end(result: { status: TraceStatus; reply?: string; firstTokenMs?: number; error?: unknown }): Promise<void> {
      if (!trace) return;
      const error = result.error instanceof Error ? `${result.error.name}: ${result.error.message}` : result.error === undefined ? undefined : String(result.error);
      record('turn', trace.name, {
        status: result.status,
        durationMs: Date.now() - started,
        data: {
          reply: clip(result.reply ?? '', 4_000),
          ...(result.firstTokenMs === undefined ? {} : { firstTokenMs: result.firstTokenMs }),
          ...(error ? { error: clip(error, 400) } : {}),
          ...totals,
        },
      });
      await writer.flush();
    },
    elapsed: () => Date.now() - started,
  };
}
