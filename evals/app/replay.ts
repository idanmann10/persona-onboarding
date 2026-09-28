import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { CallEndReason, SessionEvent, Toolkit } from '../../lib/domain/events';
import { projectSession } from '../../lib/domain/project';
import { prepareTurn } from '../../lib/agent/turn';
import { afterTurn, reconcile } from '../../lib/agent/follow-ups';
import { generateTurnResult } from '../../lib/agent/runtime';
import { PROMPT_VERSION } from '../../lib/agent/prompts';
import { writeFirstMessage } from '../../lib/agent/first-message';
import type { TraceEntry } from '../../lib/observability/trace';
import { createMemoryStore } from './memory-store';
import { createFixtureComposio, FIXTURE_VERSION, type FixtureRead } from './fixtures';

const toolkit = z.enum(['gmail', 'calendar']);
const stepSchema = z.union([
  z.object({ user: z.string().min(1) }),
  z.object({ call: z.array(z.tuple([z.enum(['user', 'assistant']), z.string().min(1)])).min(1), end: z.enum(['user_hangup', 'remote_hangup', 'connection_lost', 'inactive', 'page_closed']) }),
  z.object({ connect: toolkit }),
  z.object({ decline: z.enum(['call', 'gmail', 'calendar']) }),
]);
const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  title: z.string().min(1),
  critical: z.boolean(),
  setup: z.object({ connected: z.array(toolkit).default([]) }).default({ connected: [] }),
  steps: z.array(stepSchema).min(1),
  expect: z.object({
    tools: z.array(z.string()).default([]),
    facts: z.record(z.string(), z.string()).default({}),
    followUp: z.enum(['message', 'silent']).optional(),
    mentions: z.array(z.string()).default([]),
    notMentions: z.array(z.string()).default([]),
    /** Tools that must not be used anywhere in the scenario. */
    notTools: z.array(z.string()).default([]),
  }).default({ tools: [], facts: {}, mentions: [], notMentions: [], notTools: [] }),
  rubric: z.array(z.string()).min(1),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Step = z.infer<typeof stepSchema>;

export function parseScenarios(input: unknown): Scenario[] {
  const scenarios = z.array(scenarioSchema).parse(input);
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario ID: ${scenario.id}`);
    ids.add(scenario.id);
  }
  return scenarios;
}

export interface ToolTrace { name: string; input: unknown; output: unknown }

/** The tools a follow-up turn used, from the agent log it wrote (the follow-up runs inside the app's own pipeline). */
export function followUpTools(traces: TraceEntry[]): ToolTrace[] {
  const parse = (value: unknown) => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return value; } };
  return traces.filter((entry) => entry.kind === 'step' && entry.turnId.startsWith('followup:'))
    .flatMap((entry) => (Array.isArray(entry.data?.tools) ? entry.data.tools : []) as Array<{ name: string; input?: unknown; preview?: unknown }>)
    .map((item) => ({ name: item.name, input: parse(item.input), output: parse(item.preview) }));
}

/**
 * What the app does after a call ends or an account connects: the assistant is woken and decides, and a
 * follow-up is written only if it (and the code guardrails) say so. Returns the message, if any.
 */
export async function settleFollowUps(deps: Parameters<typeof reconcile>[0], sessionId: string, store: { events: SessionEvent[]; traces: TraceEntry[] }) {
  const events = store.events.length;
  const traces = store.traces.length;
  await reconcile(deps, sessionId);
  const message = store.events.slice(events).find((event): event is Extract<SessionEvent, { type: 'message' }> => event.type === 'message' && event.origin === 'follow_up');
  return { text: message?.text ?? null, tools: followUpTools(store.traces.slice(traces)) };
}
export interface StepTrace {
  index: number;
  kind: 'user' | 'call' | 'connect' | 'decline';
  input: string;
  /** Assistant text shown to the user after this step; null when it stayed silent or nothing ran. */
  output: string | null;
  tools: ToolTrace[];
  /** Connection state at the time the step's output was produced. */
  connected: Toolkit[];
  followUp?: 'message' | 'silent';
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Model steps the turn took (tool steps plus the reply). */
  modelSteps?: number;
}

export interface ScenarioTrace {
  scenarioId: string;
  promptVersion: string;
  fixtureVersion: string;
  steps: StepTrace[];
  reads: FixtureRead[];
  finalProgress: ReturnType<typeof projectSession>['onboarding'];
  events: SessionEvent[];
}

const SESSION = 'eval-session';

/**
 * Replay a scenario through the real turn builder, tools, gates and follow-up triggers, with an
 * in-memory store and Composio fixtures. Only the language model is live (or scripted in tests).
 */
export interface ReplayOptions {
  /** A scripted model for harness tests. Without it, the live model runs with the app's settings. */
  model?: LanguageModel;
  textModel?: string;
  reasoningEffort?: string;
  clock?: () => Date;
}

export async function replayScenario(scenario: Scenario, options: ReplayOptions): Promise<ScenarioTrace> {
  const clock = options.clock ?? (() => new Date('2026-09-27T12:00:00Z'));
  const connected: Partial<Record<Toolkit, string>> = {};
  for (const name of scenario.setup.connected) connected[name] = `ca_fixture_${name}`;
  const store = createMemoryStore(connected);
  const composio = createFixtureComposio(connected);
  const env = {
    OPENAI_API_KEY: 'eval', OPENAI_TEXT_MODEL: options.textModel ?? 'scripted', OPENAI_REASONING_EFFORT: options.reasoningEffort,
    COMPOSIO_API_KEY: 'fixture', COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'ac_gmail', COMPOSIO_CALENDAR_AUTH_CONFIG_ID: 'ac_calendar',
  };
  let tick = 0;
  const now = () => new Date(clock().getTime() + (tick += 1_000));
  // The trace sink collects the follow-up turns' tool calls; the scripted model (if any) runs the background agents too.
  const deps = { store, env, composio, now, trace: store, ...(options.model ? { model: options.model } : {}) };
  const steps: StepTrace[] = [];
  // Start where a real session starts: the opening message is on screen, and accounts connected
  // before the scenario have the event the app records when a connection completes.
  // The assistant writes its own first message, as the app does when a conversation opens.
  await writeFirstMessage(deps, SESSION);
  for (const name of scenario.setup.connected) {
    await store.appendEvent(SESSION, { id: `connection:${name}:setup:connected`, at: now().toISOString(), type: 'connection', toolkit: name, phase: 'connected' });
  }

  async function runTurn(turnId: string) {
    const turn = await prepareTurn(deps, SESSION, await store.readEvents(), { turnId });
    const result = await generateTurnResult(turn, env, options.model);
    const tools: ToolTrace[] = result.steps.flatMap((step) => step.toolResults.map((toolResult) => ({ name: toolResult.toolName, input: toolResult.input, output: toolResult.output })));
    const text = result.steps.map((step) => step.text.trim()).filter(Boolean).join('\n\n');
    return { text, tools, usage: { inputTokens: result.totalUsage?.inputTokens, outputTokens: result.totalUsage?.outputTokens }, modelSteps: result.steps.length };
  }

  for (const [index, step] of scenario.steps.entries()) {
    const connectedNow = () => (Object.keys(connected) as Toolkit[]);
    if ('user' in step) {
      const turnId = `${scenario.id}-u${index}`;
      await store.appendEvent(SESSION, { id: turnId, at: now().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: step.user });
      const { text, tools, usage, modelSteps } = await runTurn(turnId);
      if (text) await store.appendEvent(SESSION, { id: `answer:${turnId}`, at: now().toISOString(), type: 'message', speaker: 'assistant', channel: 'text', text });
      // As the chat route does after the stream: the memory.
      await afterTurn(deps, SESSION, turnId);
      steps.push({ index, kind: 'user', input: step.user, output: text || null, tools, connected: connectedNow(), usage, modelSteps });
      continue;
    }
    if ('decline' in step) {
      const at = now().toISOString();
      await store.appendEvent(SESSION, step.decline === 'call'
        ? { id: `${scenario.id}-decline-${index}`, at, type: 'call', phase: 'declined' }
        : { id: `${scenario.id}-decline-${index}`, at, type: 'connection', toolkit: step.decline, phase: 'declined' });
      steps.push({ index, kind: 'decline', input: step.decline, output: null, tools: [], connected: connectedNow() });
      continue;
    }
    if ('call' in step) {
      const callId = `live_${scenario.id}_${index}`;
      await store.appendEvent(SESSION, { id: `call:${callId}:accepted`, at: now().toISOString(), type: 'call', phase: 'accepted', callId });
      await store.appendEvent(SESSION, { id: `call:${callId}:started`, at: now().toISOString(), type: 'call', phase: 'started', callId });
      let ms = 0;
      for (const [line, [speaker, text]] of step.call.entries()) {
        await store.appendEvent(SESSION, { id: `voice:${callId}:${line}`, at: now().toISOString(), type: 'voice_fragment', callId, speaker, text, startMs: ms, endMs: ms + 2_000, final: false });
        ms += 3_000;
      }
      const reason: CallEndReason = step.end;
      await store.appendEvent(SESSION, { id: `call:${callId}:${reason === 'connection_lost' ? 'dropped' : 'ended'}`, at: now().toISOString(), type: 'call', phase: reason === 'connection_lost' ? 'dropped' : 'ended', callId, reason });
    } else {
      connected[step.connect] = `ca_fixture_${step.connect}`;
      await store.appendEvent(SESSION, { id: `connection:${step.connect}:${scenario.id}-${index}:connected`, at: now().toISOString(), type: 'connection', toolkit: step.connect, phase: 'connected' });
    }
    const { text, tools } = await settleFollowUps(deps, SESSION, store);
    steps.push({
      index, kind: 'call' in step ? 'call' : 'connect', input: 'call' in step ? step.call.map(([speaker, text]) => `${speaker}: ${text}`).join(' | ') + ` [${step.end}]` : step.connect,
      output: text, tools, connected: connectedNow(), followUp: text ? 'message' : 'silent',
    });
  }
  const events = await store.readEvents();
  return { scenarioId: scenario.id, promptVersion: PROMPT_VERSION, fixtureVersion: FIXTURE_VERSION, steps, reads: composio.reads, finalProgress: projectSession(events).onboarding, events };
}
