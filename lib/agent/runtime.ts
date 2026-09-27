import { generateText, stepCountIs, streamText, type LanguageModel, type StopCondition, type ToolSet } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { PreparedTurn, TurnDependencies } from './turn';
import { createComposioClient } from '../integrations/composio';
import { resolveIdentityClaim } from '../research/service';
import { isTraceSink, type TraceStatus } from '../observability/trace';
import { turnTracer } from '../observability/turn-trace';

type ResearchStore = Parameters<typeof resolveIdentityClaim>[0];
type Env = Record<string, string | undefined>;

/** Provider wiring for a turn: only what the configured environment enables. */
export function turnDependencies(store: TurnDependencies['store'] & ResearchStore, env: Env = process.env): TurnDependencies {
  return {
    store,
    env,
    ...(isTraceSink(store) ? { trace: store } : {}),
    composio: env.COMPOSIO_API_KEY ? createComposioClient(env.COMPOSIO_API_KEY) : undefined,
    resolveIdentity: env.CONTEXT_DEV_API_KEY
      ? (sessionId, userEvent, clue) => resolveIdentityClaim(store, sessionId, userEvent, clue, env.CONTEXT_DEV_API_KEY!)
      : undefined,
  };
}

/** Model steps per turn. Saving several facts and showing a card can take one step each. */
export const MAX_STEPS = 6;

/** A stalled request fails in under a minute instead of leaving the user watching dots; it is retried once. */
function timeoutFor(env: Env) {
  const stepMs = Number(env.MODEL_STEP_TIMEOUT_MS) || 45_000;
  return { stepMs, totalMs: Math.max(stepMs * 2, 100_000) };
}
const isTimeout = (error: unknown) => error instanceof Error && /time(d)? ?out/i.test(`${error.name} ${error.message}`);

/** Tools whose only effect is a saved fact or a card on screen: a reply beside them needs no further step. */
const CARD_TOOLS = new Set(['remember', 'customize', 'note_decline', 'graduate', 'offer_call', 'show_connection', 'propose_automation']);
const CARD_DONE = new Set(['saved', 'unchanged', 'offered', 'already_offered', 'shown', 'already_shown', 'proposed', 'already_proposed', 'already_connected', 'already_on_call']);

/**
 * A step that wrote the reply and only put up cards is the whole turn. Another step would only repeat
 * the reply (seen live: the answer written twice around a preview card). A rejected or refused card
 * still gets a step, so the model can correct what it said.
 */
const repliedWithCards: StopCondition<ToolSet> = ({ steps }) => {
  const last = steps.at(-1);
  if (!last?.text.trim() || !last.toolResults.length) return false;
  return last.toolResults.every((result) => CARD_TOOLS.has(result.toolName) && CARD_DONE.has(String((result.output as { status?: unknown } | undefined)?.status)));
};

/** The last step may not call tools, so a turn that spent its budget on tools still ends in a reply. */
function lastStepWrites({ stepNumber }: { stepNumber: number }) {
  return stepNumber >= MAX_STEPS - 1 ? { toolChoice: 'none' as const } : undefined;
}

function modelSettings(env: Env, override?: LanguageModel) {
  if (override) return { model: override };
  const effort = env.OPENAI_REASONING_EFFORT;
  return {
    model: openai(env.OPENAI_TEXT_MODEL!) as LanguageModel,
    providerOptions: { openai: { reasoningEffort: effort === 'none' || effort === 'medium' || effort === 'high' ? effort : 'low' } },
  };
}

function turnSettings(turn: PreparedTurn, env: Env, override?: LanguageModel) {
  return {
    ...modelSettings(env, override), system: turn.instructions, messages: turn.messages, tools: turn.tools,
    allowSystemInMessages: turn.allowSystemInMessages, stopWhen: [stepCountIs(MAX_STEPS), repliedWithCards], prepareStep: lastStepWrites, timeout: timeoutFor(env),
  };
}

const failureStatus = (error: unknown): TraceStatus => isTimeout(error) ? 'timeout' : 'error';

/** Stream a turn's text. A tool step between two pieces of text gets a paragraph break. */
export async function* streamTurn(turn: PreparedTurn, env: Env = process.env, override?: LanguageModel): AsyncGenerator<string> {
  const tracer = turnTracer(turn.trace);
  tracer.start();
  let reply = '';
  let firstTokenMs: number | undefined;
  let outcome: { status: TraceStatus; error?: unknown } = { status: 'error', error: 'The reply stream was closed before it finished' };
  try {
    for (let attempt = 1; ; attempt++) {
      let emitted = false;
      try {
        const result = streamText({ ...turnSettings(turn, env, override), onStepEnd: tracer.step });
        let pendingBreak = false;
        for await (const part of result.fullStream) {
          if (part.type === 'finish-step') pendingBreak = emitted;
          else if (part.type === 'text-delta' && part.text) {
            if (pendingBreak) { yield '\n\n'; reply += '\n\n'; pendingBreak = false; }
            emitted = true;
            firstTokenMs ??= tracer.elapsed();
            reply += part.text;
            yield part.text;
          } else if (part.type === 'error') throw part.error;
        }
        outcome = { status: 'ok' };
        return;
      } catch (error) {
        // Tools are idempotent per turn, so a stall before any text can safely run the turn again.
        if (emitted || attempt > 1 || !isTimeout(error)) throw error;
        tracer.stalled(attempt);
        console.warn('Model request stalled before replying; retrying once');
      }
    }
  } catch (error) {
    outcome = { status: failureStatus(error), error };
    throw error;
  } finally {
    await tracer.end({ ...outcome, reply, firstTokenMs });
  }
}

/** The full result (steps, tool calls, usage) for callers that inspect it, such as the scenario replay. */
export async function generateTurnResult(turn: PreparedTurn, env: Env = process.env, override?: LanguageModel) {
  const tracer = turnTracer(turn.trace);
  tracer.start();
  const run = () => generateText({ ...turnSettings(turn, env, override), onStepEnd: tracer.step });
  try {
    let result: Awaited<ReturnType<typeof run>>;
    try { result = await run(); }
    catch (error) {
      if (!isTimeout(error)) throw error;
      tracer.stalled(1);
      console.warn('Model request stalled; retrying once');
      result = await run();
    }
    await tracer.end({ status: 'ok', reply: result.steps.map((step) => step.text.trim()).filter(Boolean).join('\n\n') });
    return result;
  } catch (error) {
    await tracer.end({ status: failureStatus(error), error });
    throw error;
  }
}

export async function generateTurn(turn: PreparedTurn, env: Env = process.env, override?: LanguageModel): Promise<string> {
  const result = await generateTurnResult(turn, env, override);
  return result.steps.map((step) => step.text.trim()).filter(Boolean).join('\n\n');
}
