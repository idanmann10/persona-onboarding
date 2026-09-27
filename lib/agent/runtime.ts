import { generateText, stepCountIs, streamText, type LanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { PreparedTurn, TurnDependencies } from './turn';
import { createComposioClient } from '../integrations/composio';
import { resolveIdentityClaim } from '../research/service';

type ResearchStore = Parameters<typeof resolveIdentityClaim>[0];

/** Provider wiring for a turn: only what the configured environment enables. */
export function turnDependencies(store: TurnDependencies['store'] & ResearchStore, env: Record<string, string | undefined> = process.env): TurnDependencies {
  return {
    store,
    env,
    composio: env.COMPOSIO_API_KEY ? createComposioClient(env.COMPOSIO_API_KEY) : undefined,
    resolveIdentity: env.CONTEXT_DEV_API_KEY
      ? (sessionId, userEvent, clue) => resolveIdentityClaim(store, sessionId, userEvent, clue, env.CONTEXT_DEV_API_KEY!)
      : undefined,
  };
}

export function textModel(env: Record<string, string | undefined> = process.env): { model: LanguageModel; providerOptions: { openai: { reasoningEffort: 'none' | 'low' | 'medium' | 'high' } } } {
  const effort = env.OPENAI_REASONING_EFFORT;
  return {
    model: openai(env.OPENAI_TEXT_MODEL!),
    providerOptions: { openai: { reasoningEffort: effort === 'none' || effort === 'medium' || effort === 'high' ? effort : 'low' } },
  };
}

/** Stream a turn's text. A tool step between two pieces of text gets a paragraph break. */
export async function* streamTurn(turn: PreparedTurn, env: Record<string, string | undefined> = process.env): AsyncGenerator<string> {
  const { model, providerOptions } = textModel(env);
  const result = streamText({
    model, system: turn.instructions, messages: turn.messages, tools: turn.tools, allowSystemInMessages: turn.allowSystemInMessages,
    stopWhen: stepCountIs(4), providerOptions,
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

export async function generateTurn(turn: PreparedTurn, env: Record<string, string | undefined> = process.env): Promise<string> {
  const { model, providerOptions } = textModel(env);
  const result = await generateText({
    model, system: turn.instructions, messages: turn.messages, tools: turn.tools, allowSystemInMessages: turn.allowSystemInMessages,
    stopWhen: stepCountIs(4), providerOptions,
  });
  return result.steps.map((step) => step.text.trim()).filter(Boolean).join('\n\n');
}
