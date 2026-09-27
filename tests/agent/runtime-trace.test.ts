import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { generateTurn, streamTurn } from '../../lib/agent/runtime';
import type { PreparedTurn } from '../../lib/agent/turn';
import type { TraceEntry } from '../../lib/observability/trace';

const usage = { inputTokens: { total: 100, noCache: 40, cacheRead: 60, cacheWrite: 0 }, outputTokens: { total: 12, text: 10, reasoning: 2 } };

function tracedTurn(entries: TraceEntry[], failWrites = false): PreparedTurn {
  return {
    instructions: 'SYSTEM PROMPT', messages: [{ role: 'user', content: "I'm Dana" }],
    tools: { remember: tool({ inputSchema: z.object({ value: z.string() }), execute: async () => ({ status: 'saved' }) }) },
    state: undefined as never, allowSystemInMessages: false,
    trace: {
      sink: { appendTrace: async (_sessionId, entry) => { if (failWrites) throw new Error('database down'); entries.push(entry); } },
      sessionId: 's1', turnId: 'm1', name: 'Reply', data: { instructions: 'SYSTEM PROMPT', promptVersion: 'understand-user/v4' },
    },
  };
}

describe('turn tracing', () => {
  it('records the start, each step with its tools and tokens, and the end with totals', async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        return calls === 1
          ? { content: [{ type: 'tool-call' as const, toolCallId: 't1', toolName: 'remember', input: JSON.stringify({ value: 'Dana' }) }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] }
          : { content: [{ type: 'text' as const, text: 'Hi Dana.' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] };
      },
    });
    const entries: TraceEntry[] = [];
    expect(await generateTurn(tracedTurn(entries), {}, model)).toBe('Hi Dana.');
    expect(entries.map((entry) => [entry.kind, entry.status])).toEqual([['turn', 'running'], ['step', 'ok'], ['step', 'ok'], ['turn', 'ok']]);
    expect(entries[0].data).toMatchObject({ instructions: 'SYSTEM PROMPT' });
    expect(entries[1].data).toMatchObject({ index: 1, tokensIn: 100, cachedIn: 60, tokensOut: 12, reasoningTokens: 2, finishReason: 'tool-calls', tools: [{ name: 'remember', status: 'saved' }] });
    expect(entries[3]).toMatchObject({ turnId: 'm1', name: 'Reply', data: { reply: 'Hi Dana.', steps: 2, toolCalls: 1, tokensIn: 200, cachedIn: 120 } });
    expect(entries[3].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records time to first token for a streamed turn', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 'a' },
          { type: 'text-delta' as const, id: 'a', delta: 'Hi ' },
          { type: 'text-delta' as const, id: 'a', delta: 'Dana.' },
          { type: 'text-end' as const, id: 'a' },
          { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
        ]),
      }),
    });
    const entries: TraceEntry[] = [];
    const chunks: string[] = [];
    for await (const chunk of streamTurn(tracedTurn(entries), {}, model)) chunks.push(chunk);
    expect(chunks.join('')).toBe('Hi Dana.');
    const end = entries.at(-1)!;
    expect(end).toMatchObject({ kind: 'turn', status: 'ok', data: { reply: 'Hi Dana.', steps: 1 } });
    expect(typeof end.data?.firstTokenMs).toBe('number');
  });

  it('records a failed turn and still throws the original error', async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error('provider exploded'); } });
    const entries: TraceEntry[] = [];
    await expect(generateTurn(tracedTurn(entries), {}, model)).rejects.toThrow('provider exploded');
    expect(entries.at(-1)).toMatchObject({ kind: 'turn', status: 'error' });
    expect(String(entries.at(-1)?.data?.error)).toContain('provider exploded');
  });

  it('never lets a failing trace write break the reply', async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => ({ content: [{ type: 'text' as const, text: 'Still here.' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] }) });
    expect(await generateTurn(tracedTurn([], true), {}, model)).toBe('Still here.');
  });
});
