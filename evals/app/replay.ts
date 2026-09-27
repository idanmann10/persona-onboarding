import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { CallEndReason, SessionEvent, Toolkit } from '../../lib/domain/events';
import { projectSession } from '../../lib/domain/project';
import { prepareTurn, type TurnTrigger } from '../../lib/agent/turn';
import { describeTrigger, isSilent } from '../../lib/agent/follow-up';
import { generateTurnResult } from '../../lib/agent/runtime';
import { PROMPT_VERSION } from '../../lib/agent/prompts';
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
  }).default({ tools: [], facts: {}, mentions: [], notMentions: [] }),
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
  const deps = { store, env, composio, now };
  const steps: StepTrace[] = [];

  async function runTurn(turnId: string, trigger?: TurnTrigger) {
    const turn = await prepareTurn(deps, SESSION, await store.readEvents(), { turnId, trigger });
    const result = await generateTurnResult(turn, env, options.model);
    const tools: ToolTrace[] = result.steps.flatMap((step) => step.toolResults.map((toolResult) => ({ name: toolResult.toolName, input: toolResult.input, output: toolResult.output })));
    const text = result.steps.map((step) => step.text.trim()).filter(Boolean).join('\n\n');
    return { text, tools, usage: { inputTokens: result.totalUsage?.inputTokens, outputTokens: result.totalUsage?.outputTokens } };
  }

  for (const [index, step] of scenario.steps.entries()) {
    const connectedNow = () => (Object.keys(connected) as Toolkit[]);
    if ('user' in step) {
      const turnId = `${scenario.id}-u${index}`;
      await store.appendEvent(SESSION, { id: turnId, at: now().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: step.user });
      const { text, tools, usage } = await runTurn(turnId);
      if (text) await store.appendEvent(SESSION, { id: `answer:${turnId}`, at: now().toISOString(), type: 'message', speaker: 'assistant', channel: 'text', text });
      steps.push({ index, kind: 'user', input: step.user, output: text || null, tools, connected: connectedNow(), usage });
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
    let request: Parameters<typeof describeTrigger>[1];
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
      request = { kind: 'call_ended', callId };
    } else {
      connected[step.connect] = `ca_fixture_${step.connect}`;
      await store.appendEvent(SESSION, { id: `connection:${step.connect}:${scenario.id}-${index}:connected`, at: now().toISOString(), type: 'connection', toolkit: step.connect, phase: 'connected' });
      request = { kind: 'connection', toolkit: step.connect };
    }
    const trigger = describeTrigger(projectSession(await store.readEvents()), request);
    if (!trigger) throw new Error(`Scenario ${scenario.id} step ${index} produced no follow-up trigger`);
    const { text, tools, usage } = await runTurn(trigger.id, trigger);
    const silent = isSilent(text);
    const at = now().toISOString();
    if (!silent) await store.appendEvent(SESSION, { id: `answer:${trigger.id}`, at, type: 'message', speaker: 'assistant', channel: 'text', text: text.trim(), origin: 'follow_up' });
    await store.appendEvent(SESSION, { id: `decision:${trigger.id}`, at, type: 'decision', trigger: trigger.id, outcome: silent ? 'silent' : 'messaged' });
    steps.push({
      index, kind: 'call' in step ? 'call' : 'connect', input: 'call' in step ? step.call.map(([speaker, text]) => `${speaker}: ${text}`).join(' | ') + ` [${step.end}]` : step.connect,
      output: silent ? null : text.trim(), tools, connected: connectedNow(), followUp: silent ? 'silent' : 'message', usage,
    });
  }
  const events = await store.readEvents();
  return { scenarioId: scenario.id, promptVersion: PROMPT_VERSION, fixtureVersion: FIXTURE_VERSION, steps, reads: composio.reads, finalProgress: projectSession(events).onboarding, events };
}
