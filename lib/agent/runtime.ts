import { generateText, stepCountIs, streamText, type LanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { PreparedTurn, TurnDependencies } from './turn';
import { createComposioClient } from '../integrations/composio';
import { resolveIdentityClaim } from '../research/service';

type ResearchStore = Parameters<typeof resolveIdentityClaim>[0];
type Env = Record<string, string | undefined>;

/** Provider wiring for a turn: only what the configured environment enables. */
export function turnDependencies(store: TurnDependencies['store'] & ResearchStore, env: Env = process.env): TurnDependencies {
  return {
    store,
    env,
    composio: env.COMPOSIO_API_KEY ? createComposioClient(env.COMPOSIO_API_KEY) : undefined,
    resolveIdentity: env.CONTEXT_DEV_API_KEY
      ? (sessionId, userEvent, clue) => resolveIdentityClaim(store, sessionId, userEvent, clue, env.CONTEXT_DEV_API_KEY!)
      : undefined,
  };
}

function modelSettings(env: Env, override?: LanguageModel) {
  if (override) return { model: override };
  const effort = env.OPENAI_REASONING_EFFORT;
  return {
    model: openai(env.OPENAI_TEXT_MODEL!) as LanguageModel,
    providerOptions: { openai: { reasoningEffort: effort === 'none' || effort === 'medium' || effort === 'high' ? effort : 'low' } },
  };
}

/** Stream a turn's text. A tool step between two pieces of text gets a paragraph break. */
export async function* streamTurn(turn: PreparedTurn, env: Env = process.env, override?: LanguageModel): AsyncGenerator<string> {
  const result = streamText({
    ...modelSettings(env, override), system: turn.instructions, messages: turn.messages, tools: turn.tools,
    allowSystemInMessages: turn.allowSystemInMessages, stopWhen: stepCountIs(4),
  });
  let emitted = false;
  let pendingBreak = false;
  for await (const part of result.fullStream) {
    if (part.type === 'finish-step') pendingBreak = emitted;
    else if (part.type === 'text-delta' && part.text) {
      if (pendingBreak) { yield '\n\n'; pendingBreak = false; }
      emitted = true;
      yield part.text;
    } else if (part.type === 'error') throw part.error;
  }
}

/** The full result (steps, tool calls, usage) for callers that inspect it, such as the scenario replay. */
export function generateTurnResult(turn: PreparedTurn, env: Env = process.env, override?: LanguageModel) {
  return generateText({
    ...modelSettings(env, override), system: turn.instructions, messages: turn.messages, tools: turn.tools,
    allowSystemInMessages: turn.allowSystemInMessages, stopWhen: stepCountIs(4),
  });
}

export async function generateTurn(turn: PreparedTurn, env: Env = process.env, override?: LanguageModel): Promise<string> {
  const result = await generateTurnResult(turn, env, override);
  return result.steps.map((step) => step.text.trim()).filter(Boolean).join('\n\n');
}
