import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { generateTurn, MAX_STEPS } from '../../lib/agent/runtime';
import type { PreparedTurn } from '../../lib/agent/turn';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

describe('turn runtime', () => {
  it('ends with a reply even when the model keeps calling tools', async () => {
    let calls = 0;
    const saved: string[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls++;
        // A model that would call a tool forever, unless the step forbids tools.
        if (options.toolChoice?.type === 'none') return { content: [{ type: 'text' as const, text: 'Hi Dana, Max here.' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] };
        return { content: [{ type: 'tool-call' as const, toolCallId: `c${calls}`, toolName: 'remember', input: JSON.stringify({ value: `fact ${calls}` }) }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] };
      },
    });
    const turn: PreparedTurn = {
      instructions: 'test', messages: [{ role: 'user', content: "I'm Dana, call yourself Max, and I need help with my inbox." }],
      tools: { remember: tool({ inputSchema: z.object({ value: z.string() }), execute: async ({ value }) => { saved.push(value); return { status: 'saved' }; } }) },
      state: undefined as never, allowSystemInMessages: false,
    };
    expect(await generateTurn(turn, {}, model)).toBe('Hi Dana, Max here.');
    expect(calls).toBe(MAX_STEPS);
    expect(saved).toHaveLength(MAX_STEPS - 1);
  });

  it('ends the turn when the reply was written beside cards that went up, instead of writing it twice', async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        return {
          content: [
            { type: 'text' as const, text: 'Dana needs your answer by Friday. Want this every weekday at 8?' },
            { type: 'tool-call' as const, toolCallId: `p${calls}`, toolName: 'propose_automation', input: '{}' },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [],
        };
      },
    });
    const turn: PreparedTurn = {
      instructions: 'test', messages: [{ role: 'user', content: 'anything waiting on me?' }],
      tools: { propose_automation: tool({ inputSchema: z.object({}), execute: async () => ({ status: 'proposed' }) }) },
      state: undefined as never, allowSystemInMessages: false,
    };
    expect(await generateTurn(turn, {}, model)).toBe('Dana needs your answer by Friday. Want this every weekday at 8?');
    expect(calls).toBe(1);
  });

  it('keeps going when a card was refused, so the reply can be corrected', async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        return calls === 1
          ? { content: [{ type: 'text' as const, text: 'Here is a preview.' }, { type: 'tool-call' as const, toolCallId: 'p1', toolName: 'propose_automation', input: '{}' }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] }
          : { content: [{ type: 'text' as const, text: 'You already have one running; want me to swap it?' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] };
      },
    });
    const turn: PreparedTurn = {
      instructions: 'test', messages: [{ role: 'user', content: 'every weekday at 8' }],
      tools: { propose_automation: tool({ inputSchema: z.object({}), execute: async () => ({ status: 'one_active' }) }) },
      state: undefined as never, allowSystemInMessages: false,
    };
    expect(await generateTurn(turn, {}, model)).toContain('swap it');
    expect(calls).toBe(2);
  });

  it('retries once when a request stalls, and gives up after that', async () => {
    let calls = 0;
    const stalled = (signal?: AbortSignal) => new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls++;
        if (calls === 1) return stalled(options.abortSignal);
        return { content: [{ type: 'text' as const, text: 'Back on track.' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] };
      },
    });
    const turn: PreparedTurn = { instructions: 'test', messages: [{ role: 'user', content: 'hi' }], tools: {}, state: undefined as never, allowSystemInMessages: false };
    expect(await generateTurn(turn, { MODEL_STEP_TIMEOUT_MS: '30' }, model)).toBe('Back on track.');
    expect(calls).toBe(2);
    const alwaysStalls = new MockLanguageModelV3({ doGenerate: async (options) => stalled(options.abortSignal) });
    await expect(generateTurn(turn, { MODEL_STEP_TIMEOUT_MS: '30' }, alwaysStalls)).rejects.toThrow(/time/i);
  });
});
