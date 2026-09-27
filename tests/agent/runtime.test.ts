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
});
