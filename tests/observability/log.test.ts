import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../lib/domain/events';
import { projectSession } from '../../lib/domain/project';
import { buildAgentLog, groupTurns } from '../../lib/observability/log';
import type { StoredTrace } from '../../lib/observability/trace';
import { turnName } from '../../lib/observability/trace';

const T0 = Date.parse('2026-09-27T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
let id = 0;
const trace = (entry: Omit<StoredTrace, 'id'>): StoredTrace => ({ id: ++id, ...entry });

const traces: StoredTrace[] = [
  trace({ turnId: 'm1', kind: 'turn', name: 'Reply', at: at(0), status: 'running', data: { model: 'gpt-6-luna', promptVersion: 'understand-user/v4', instructions: 'SYSTEM', messageCount: 2, tools: ['remember', 'offer_call'], userText: 'I am Dana' } }),
  trace({ turnId: 'm1', kind: 'step', name: 'Step 1', at: at(900), durationMs: 900, status: 'ok', data: { modelMs: 800, toolMs: 100, tokensIn: 1000, cachedIn: 500, tokensOut: 20, reasoningTokens: 5, finishReason: 'tool-calls', tools: [{ name: 'remember', input: '{"key":"preferred_name"}', status: 'saved', ms: 100 }] } }),
  trace({ turnId: 'm1', kind: 'step', name: 'Step 2', at: at(1500), durationMs: 600, status: 'ok', data: { modelMs: 600, toolMs: 0, tokensIn: 1100, cachedIn: 1000, tokensOut: 30, finishReason: 'stop', text: 'Hi Dana', tools: [] } }),
  trace({ turnId: 'm1', kind: 'turn', name: 'Reply', at: at(1510), durationMs: 1510, status: 'ok', data: { reply: 'Hi Dana', firstTokenMs: 1000 } }),
  trace({ turnId: 'live_abc', kind: 'call', name: 'Call setup', at: at(5000), durationMs: 420, status: 'ok', data: { model: 'gpt-live-1', voice: 'marin', delegation: 'on', instructionsChars: 3000, seededMessages: 4 } }),
  trace({ turnId: 'live_abc', kind: 'voice_tool', name: 'remember', at: at(9000), durationMs: 40, status: 'ok', data: { input: '{"value":"inbox"}', status: 'saved' } }),
  trace({ turnId: 'followup:call:live_abc', kind: 'turn', name: 'After the call', at: at(20_000), status: 'running', data: { trigger: 'The call ended.' } }),
  trace({ turnId: 'followup:call:live_abc', kind: 'step', name: 'Stalled, retrying', at: at(65_000), durationMs: 45_000, status: 'timeout', data: { attempt: 1 } }),
  trace({ turnId: 'followup:call:live_abc', kind: 'turn', name: 'After the call', at: at(66_000), durationMs: 46_000, status: 'timeout', data: { error: 'TimeoutError: timed out' } }),
  trace({ turnId: 'm2', kind: 'turn', name: 'Reply', at: at(70_000), status: 'running', data: { userText: 'still there?' } }),
];

const events: SessionEvent[] = [
  { id: 'fact-1', at: at(800), type: 'fact', key: 'preferred_name', value: 'Dana', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm1' },
  { id: 'call:live_abc:accepted', at: at(5100), type: 'call', phase: 'accepted', callId: 'live_abc' },
  { id: 'call:live_abc:started', at: at(6000), type: 'call', phase: 'started', callId: 'live_abc' },
  { id: 'call:live_abc:ended', at: at(18_000), type: 'call', phase: 'ended', callId: 'live_abc', reason: 'user_hangup' },
  { id: 'connection:gmail:failed', at: at(19_000), type: 'connection', toolkit: 'gmail', phase: 'failed' },
];

describe('agent log', () => {
  it('groups start, steps and end into turns with waterfall offsets and totals', () => {
    const turns = groupTurns(traces, T0 + 71_000);
    expect(turns.map((turn) => [turn.turnId, turn.status])).toEqual([['m1', 'ok'], ['followup:call:live_abc', 'timeout'], ['m2', 'running']]);
    const [first, followUp] = turns;
    expect(first.steps.map((step) => [step.offsetMs, step.durationMs, step.modelMs])).toEqual([[0, 900, 800], [900, 600, 600]]);
    expect(first.totals).toMatchObject({ toolCalls: 1, tokensIn: 2100, cachedIn: 1500, tokensOut: 50 });
    expect(first).toMatchObject({ firstTokenMs: 1000, reply: 'Hi Dana', userText: 'I am Dana', instructions: 'SYSTEM', toolsOffered: ['remember', 'offer_call'] });
    expect(followUp).toMatchObject({ stalls: 1, error: 'TimeoutError: timed out', trigger: 'The call ended.' });
  });

  it('marks a turn that never ended as failed once it is stale', () => {
    const [, , stale] = groupTurns(traces, T0 + 70_000 + 6 * 60_000);
    expect(stale).toMatchObject({ status: 'error' });
  });

  it('orders turns, calls and events by time and summarizes them', () => {
    const log = buildAgentLog(projectSession(events), events, traces, T0 + 71_000);
    expect(log.items.map((item) => item.kind === 'event' ? item.label : item.kind)).toEqual(['turn', 'Saved user name', 'call', 'Gmail connection failed', 'turn', 'turn']);
    const call = log.items.find((item) => item.kind === 'call');
    expect(call).toMatchObject({ callId: 'live_abc', reason: 'user_hangup', durationMs: 12_000, setup: { ms: 420, voice: 'marin', seededMessages: 4 }, tools: [{ name: 'remember', status: 'saved', ms: 40 }] });
    expect(log.summary).toMatchObject({ turns: 3, medianMs: 1510, p95Ms: 46_000, medianFirstTokenMs: 1000, steps: 2, toolCalls: 2, tokensIn: 2100, tokensOut: 50, cachedPercent: 71, calls: 1, errors: 1 });
  });

  it('names turns after what woke the assistant', () => {
    expect([undefined, 'followup:call:live_1', 'followup:connection:gmail:connected', 'automation:a:2026:schedule'].map(turnName))
      .toEqual(['Reply', 'After the call', 'After connecting', 'Recurring task']);
  });

  it('keeps a step that was written just after its turn ended inside that turn', () => {
    const at = (ms: number) => new Date(Date.UTC(2026, 8, 27, 12, 0, 0, ms)).toISOString();
    const turns = groupTurns([
      { id: 1, turnId: 'b2', kind: 'turn', name: 'Reply', at: at(0), status: 'running', data: {} },
      { id: 2, turnId: 'b2', kind: 'turn', name: 'Reply', at: at(1_000), status: 'ok', durationMs: 1_000, data: { reply: 'Text it is.' } },
      { id: 3, turnId: 'b2', kind: 'step', name: 'Step 1', at: at(990), status: 'ok', durationMs: 960, data: { text: 'Text it is.' } },
    ] as never, Date.UTC(2026, 8, 27, 12, 1));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: 'ok', steps: [expect.objectContaining({ name: 'Step 1' })] });
  });
});
