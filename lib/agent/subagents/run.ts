import { generateText, Output, type LanguageModel } from 'ai';
import type { z } from 'zod';
import type { AgentName } from '../../domain/events';
import { clip, type TraceSink } from '../../observability/trace';
import { turnTracer } from '../../observability/turn-trace';
import { failureStatus, modelSettings, timeoutFor } from '../runtime';
import { SOUL_VERSION } from '../soul';

type Env = Record<string, string | undefined>;

export interface SubagentDeps {
  env: Env;
  trace?: TraceSink;
  /** A scripted model for the eval harness; the live model otherwise. */
  model?: LanguageModel;
}

export const AGENT_LABELS: Record<Exclude<AgentName, 'assistant'>, string> = { coach: 'Onboarding coach', memory: 'Memory' };

/**
 * One background agent call: its soul-led system prompt, a small JSON input (state plus the last few
 * lines, never the whole transcript), and a zod-checked result. `gpt-6-luna` at low effort unless
 * OPENAI_SUBAGENT_MODEL says otherwise. Traced in the agent log like a turn; a failure returns undefined
 * and never reaches the user.
 */
export async function runSubagent<T>(deps: SubagentDeps, run: {
  agent: Exclude<AgentName, 'assistant'>; sessionId: string; turnId: string; system: string; input: unknown; schema: z.ZodType<T>;
}): Promise<T | undefined> {
  const prompt = JSON.stringify(run.input, null, 1);
  const model = deps.env.OPENAI_SUBAGENT_MODEL || deps.env.OPENAI_TEXT_MODEL || 'gpt-6-luna';
  const tracer = turnTracer(deps.trace ? {
    sink: deps.trace, sessionId: run.sessionId, turnId: run.turnId, name: AGENT_LABELS[run.agent],
    data: { model, promptVersion: `${run.agent}/${SOUL_VERSION}`, instructions: run.system, messageCount: 1, tools: [], channel: 'background', agent: run.agent, trigger: clip(prompt, 4_000) },
  } : undefined);
  tracer.start();
  try {
    const { stepMs } = timeoutFor(deps.env);
    const result = await generateText({
      ...modelSettings(deps.env, deps.model, { model, effort: 'low' }),
      system: run.system, prompt, output: Output.object({ schema: run.schema }), onStepEnd: tracer.step, timeout: { stepMs, totalMs: stepMs },
    });
    const output = result.output as T;
    await tracer.end({ status: 'ok', reply: JSON.stringify(output, null, 1) });
    return output;
  } catch (error) {
    console.warn(`${AGENT_LABELS[run.agent]} failed`, error instanceof Error ? error.message : error);
    await tracer.end({ status: failureStatus(error), error });
    return undefined;
  }
}
