import type { LanguageModel } from 'ai';
import type { CallEndReason, SessionEvent, Toolkit } from '../../lib/domain/events';
import { projectSession, type OnboardingProgress, type SessionProjection } from '../../lib/domain/project';
import type { AutomationRecord, AutomationStatus } from '../../lib/domain/automation';
import { prepareTurn, type TurnTrigger } from '../../lib/agent/turn';
import { afterTurn } from '../../lib/agent/follow-ups';
import { generateTurnResult } from '../../lib/agent/runtime';
import { PROMPT_VERSION } from '../../lib/agent/prompts';
import { greetingEvent } from '../../lib/agent/session';
import { VOICE_LIMITS, voiceGreeting } from '../../lib/voice/session-config';
import { createCallOfferHandler } from '../../lib/http/call-offer';
import { createConnectionHandlers } from '../../lib/http/connections';
import { createAutomationHandler } from '../../lib/http/automations';
import { createMemoryStore, EVAL_LOGIN_TOKEN } from '../app/memory-store';
import { createFixtureComposio, FIXTURE_VERSION, type FixtureRead } from '../app/fixtures';
import { settleFollowUps } from '../app/replay';
import type { Persona } from './personas';
import type { LeaveFeeling, SimAction, SimControl, SimUser } from './user';
import { pendingControls, renderCallScreen, renderScreen } from './screen';

/** The simulated person's conversation; the app's endpoints reach it through the harness's sign-in (EVAL_LOGIN_TOKEN). */
export const SIM_SESSION = '5e551a70-51a0-4000-8000-000000000001';
export const SIM_TIMEZONE = 'America/New_York';
/** The harness ends a call after this many things the person said; the last reply gets the app's wrap-up instruction. */
export const MAX_CALL_UTTERANCES = 6;
/** A mid-sentence hang-up needs a thought to cut: the harness waits for an utterance at least this long. */
export const MIN_WORDS_TO_CUT = 5;
const ORIGIN = 'http://persona.sim.test';
const TOOLKIT_NAMES: Record<Toolkit, string> = { gmail: 'Gmail', calendar: 'Google Calendar' };

export interface SimToolTrace {
  name: string;
  input: unknown;
  output: unknown;
  /** Set when the tool threw or its input was rejected. */
  error?: string;
  /** The model step (within its turn) that called the tool; text in later steps came after its result. */
  modelStep: number;
}

export type SimTurnKind = 'reply' | 'follow_up' | 'voice_greeting' | 'voice' | 'voice_notice';

/** One run of the app's turn builder and model. */
export interface SimTurn {
  kind: SimTurnKind;
  turnId: string;
  trigger?: string;
  channel: 'text' | 'voice';
  /** The model's text per model step, in order. */
  stepTexts: string[];
  text: string;
  /** Whether the text reached the person (a follow-up may choose silence). */
  shown: boolean;
  tools: SimToolTrace[];
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface SimStep {
  index: number;
  onCall: boolean;
  /** What the person saw before acting. */
  screen: string;
  action: SimAction;
  /** When the harness changed what the app received (a hang-up mid-sentence), the words that got through. */
  delivered?: string;
  /** Assistant words that reached the person after this action, in order: replies, follow-ups, spoken lines. */
  outputs: string[];
  turns: SimTurn[];
  tools: Array<{ name: string; input: unknown }>;
  followUp?: 'message' | 'silent';
  callEnded?: CallEndReason;
  /** Accounts connected when this step's outputs were produced. */
  connected: Toolkit[];
  /** A harness problem with this step, such as a tap on a button that is not on screen. */
  error?: string;
  /** The app side of this step failed (see the trace's error); its outputs are partial. */
  incomplete?: boolean;
  userLatencyMs: number;
  appLatencyMs: number;
}

export type SimStatus = 'left' | 'max_actions' | 'error';

export interface SimTrace {
  personaId: string;
  promptVersion: string;
  fixtureVersion: string;
  status: SimStatus;
  leave?: { feeling: LeaveFeeling; reason: string };
  /** Why the conversation stopped early (a model or simulated-user failure or timeout). */
  error?: string;
  /** Which side failed: the app (its model turns and endpoints) or the simulated user. */
  errorSource?: 'app' | 'user';
  steps: SimStep[];
  reads: FixtureRead[];
  events: SessionEvent[];
  finalProgress: OnboardingProgress;
  durationMs: number;
}

export interface SimOptions {
  user: SimUser;
  /** A scripted model for harness tests. Without it, the live model runs with the app's settings. */
  model?: LanguageModel;
  textModel?: string;
  reasoningEffort?: string;
  maxActions?: number;
  clock?: () => Date;
  /** Per model turn. A turn that takes longer ends the conversation with status 'error'. */
  turnTimeoutMs?: number;
  /** Per action of the simulated user. */
  userTimeoutMs?: number;
}

export class SimTimeoutError extends Error {
  override name = 'SimTimeoutError';
}

/**
 * Reject when the work takes too long. The work itself is not cancelled (the app's turn runner takes
 * no abort signal), so a late failure is swallowed rather than left unhandled.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => undefined);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SimTimeoutError(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** The words a person got out before hanging up: about 60% of the sentence, cut at a word boundary, unfinished. */
export function cutMidSentence(text: string, fraction = 0.6): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const target = Math.max(1, Math.round(clean.length * fraction));
  let cut: string;
  if (clean.includes(' ')) {
    const boundary = clean.lastIndexOf(' ', target);
    cut = boundary > 0 ? clean.slice(0, boundary) : clean.slice(0, clean.indexOf(' '));
  } else cut = clean.slice(0, Math.min(Math.max(1, clean.length - 1), target));
  return cut.replace(/[\s.,;:!?…"')\]-]+$/u, '') || clean.slice(0, 1);
}

/**
 * Transcript fragments as the call client posts them: at most 500 characters each. Each starts with a
 * space so fragments of one speaker's run join into words (the projection concatenates them as is).
 */
export function fragmentChunks(text: string, limit = 500): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)) {
    const piece = ` ${word}`.slice(0, limit);
    if (current && current.length + piece.length > limit) { chunks.push(current); current = ''; }
    current += piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

const speechMs = (text: string) => Math.min(30_000, Math.max(800, text.split(/\s+/).filter(Boolean).length * 380));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);

/** The replay's in-memory store, plus the automation methods the app's approve and decline endpoints use. */
export function createSimStore(connected: Partial<Record<Toolkit, string>>) {
  const base = createMemoryStore(connected, SIM_SESSION);
  const find = (id: string) => base.automations.find((automation) => automation.id === id);
  return {
    ...base,
    getAutomation: async (_sessionId: string, id: string) => find(id),
    /** Mirrors the Postgres store: only a proposed task can be approved, and only one can be active. */
    approveAutomation: async (_sessionId: string, id: string, timezone: string, nextRunAt: Date): Promise<'approved' | 'not_found' | 'conflict'> => {
      const automation = find(id);
      if (!automation || automation.status !== 'proposed') return 'not_found';
      if (base.automations.some((other) => other.status === 'active')) return 'conflict';
      automation.status = 'active';
      automation.timezone = timezone;
      automation.nextRunAt = nextRunAt.toISOString();
      return 'approved';
    },
    setAutomationStatus: async (_sessionId: string, id: string, from: AutomationStatus, to: 'declined' | 'disabled') => {
      const automation = find(id);
      if (!automation || automation.status !== from) return false;
      automation.status = to;
      return true;
    },
    claimDueAutomations: async (): Promise<AutomationRecord[]> => [],
    startAutomationRun: async () => false,
    finishAutomationRun: async () => undefined,
    advanceAutomation: async () => undefined,
    getConnectionAttempt: async () => undefined,
  };
}

/**
 * One simulated first session. The app side is the real one: the greeting event, the turn builder,
 * server-gated tools, follow-up triggers, the voice greeting instruction, and the app's own endpoints
 * for the Not now and Approve buttons, over an in-memory store and Gmail/Calendar fixtures. Only the
 * models (the app's and the simulated person's) are live, or scripted in tests.
 *
 * A call is simulated turn by turn: the app's voice greeting instruction and each of the person's
 * utterances run a voice-channel turn whose text becomes the assistant's spoken line. The harness
 * enforces how a call ends for personas who hang up mid-sentence or whose line drops.
 */
export async function simulate(persona: Persona, options: SimOptions): Promise<SimTrace> {
  const startedAt = Date.now();
  const maxActions = options.maxActions ?? 16;
  const turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
  const userTimeoutMs = options.userTimeoutMs ?? 300_000;
  const clock = options.clock ?? (() => new Date('2026-09-27T12:00:00Z'));
  let elapsed = 0;
  const now = () => new Date(clock().getTime() + (elapsed += 1_000));
  const connected: Partial<Record<Toolkit, string>> = {};
  const store = createSimStore(connected);
  const composio = createFixtureComposio(connected);
  const env = {
    OPENAI_API_KEY: 'eval', OPENAI_TEXT_MODEL: options.textModel ?? 'scripted', OPENAI_REASONING_EFFORT: options.reasoningEffort,
    COMPOSIO_API_KEY: 'fixture', COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'ac_gmail', COMPOSIO_CALENDAR_AUTH_CONFIG_ID: 'ac_calendar',
  };
  // The trace sink collects the follow-up turns' tool calls; the scripted model (if any) runs the background agents too.
  const deps = { store, env, composio, now, trace: store, ...(options.model ? { model: options.model } : {}) };
  const append = (event: SessionEvent) => store.appendEvent(SIM_SESSION, event);
  const project = async (): Promise<SessionProjection> => projectSession(await store.readEvents());
  const connectedNow = () => (Object.keys(connected) as Toolkit[]);

  // The buttons go through the app's own endpoints, called the way the page calls them.
  const request = (path: string, method: string, body?: unknown) => new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, cookie: `persona_auth=${EVAL_LOGIN_TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const notUsed = async (): Promise<never> => { throw new Error('OAuth is not simulated'); };
  const callOffer = createCallOfferHandler(store);
  const connections = createConnectionHandlers(store, { start: notUsed, finish: notUsed, disconnect: notUsed }, ORIGIN);
  const automations = createAutomationHandler(store, undefined, now);

  const steps: SimStep[] = [];
  let status: SimStatus = 'max_actions';
  let leave: SimTrace['leave'];
  let failure: string | undefined;
  let live: { callId: string; ordinal: number; utterances: number; ms: number; fragments: number } | undefined;
  let calls = 0;

  const note = (step: SimStep, message: string) => { step.error = step.error ? `${step.error}; ${message}` : message; };

  async function runTurn(step: SimStep, kind: SimTurnKind, turnId: string, channel: 'text' | 'voice', trigger?: TurnTrigger): Promise<SimTurn> {
    const started = Date.now();
    const turn = await prepareTurn(deps, SIM_SESSION, await store.readEvents(), { turnId, trigger, channel });
    const result = await withTimeout(generateTurnResult(turn, env, options.model), turnTimeoutMs, `The ${kind.replace('_', ' ')} turn`);
    const tools: SimToolTrace[] = result.steps.flatMap((modelStep, index) => [
      ...modelStep.toolResults.map((toolResult) => ({ name: toolResult.toolName, input: toolResult.input, output: toolResult.output, modelStep: index })),
      ...modelStep.content.flatMap((part) => part.type === 'tool-error'
        ? [{ name: part.toolName, input: part.input, output: undefined, error: errorText(part.error), modelStep: index }]
        : []),
    ]);
    const stepTexts = result.steps.map((modelStep) => modelStep.text.trim());
    const text = stepTexts.filter(Boolean).join(channel === 'voice' ? ' ' : '\n\n');
    const record: SimTurn = {
      kind, turnId, ...(trigger ? { trigger: trigger.id } : {}), channel, stepTexts, text, shown: Boolean(text), tools,
      latencyMs: Date.now() - started, usage: { inputTokens: result.totalUsage?.inputTokens, outputTokens: result.totalUsage?.outputTokens },
    };
    step.turns.push(record);
    return record;
  }

  async function speakAs(speaker: 'user' | 'assistant', text: string) {
    if (!live) return;
    for (const chunk of fragmentChunks(text)) {
      const spoken = speechMs(chunk);
      await append({ id: `voice:${live.callId}:${++live.fragments}`, at: now().toISOString(), type: 'voice_fragment', callId: live.callId, speaker, text: chunk, startMs: live.ms, endMs: live.ms + spoken, final: false });
      live.ms += spoken + 700;
      elapsed += spoken;
    }
  }

  /** Exactly the app's follow-up: the onboarding coach decides, and the code guardrails have the last word. */
  async function runFollowUp(step: SimStep) {
    const started = Date.now();
    const { text, tools } = await withTimeout(settleFollowUps(deps, SIM_SESSION, store), turnTimeoutMs, 'The follow-up');
    step.turns.push({
      kind: 'follow_up', turnId: 'follow-up', channel: 'text', stepTexts: text ? [text] : [], text: text ?? '', shown: Boolean(text),
      tools: tools.map((tool) => ({ ...tool, modelStep: 0 })), latencyMs: Date.now() - started,
    });
    if (text) step.outputs.push(text);
    step.followUp = text ? 'message' : 'silent';
  }

  async function endCall(step: SimStep, reason: CallEndReason, followUp = true) {
    if (!live) return;
    const { callId } = live;
    live = undefined;
    // As the call client reports it: a lost line and a closed page are drops (lib/voice/client.ts).
    const phase = reason === 'connection_lost' || reason === 'page_closed' ? 'dropped' : 'ended';
    await append({ id: `call:${callId}:${phase}`, at: now().toISOString(), type: 'call', phase, callId, reason });
    step.callEnded = reason;
    if (followUp) await runFollowUp(step);
  }

  async function startCall(step: SimStep) {
    // The app builds the greeting from the state before it records the new call (lib/http/voice.ts),
    // so the previous call is still the latest one (a dropped line gets "glad to be back").
    const instruction = voiceGreeting(await project());
    const callId = `live_sim_${++calls}`;
    await append({ id: `call:${callId}:accepted`, at: now().toISOString(), type: 'call', phase: 'accepted', callId });
    await append({ id: `call:${callId}:started`, at: now().toISOString(), type: 'call', phase: 'started', callId });
    live = { callId, ordinal: calls, utterances: 0, ms: 0, fragments: 0 };
    // The greeting goes to the live model as an instruction, and the assistant speaks first.
    const turn = await runTurn(step, 'voice_greeting', `${callId}:greeting`, 'voice', { id: `voice-greeting:${callId}`, instruction });
    if (turn.text) { await speakAs('assistant', turn.text); step.outputs.push(turn.text); }
  }

  async function connect(step: SimStep, toolkit: Toolkit) {
    connected[toolkit] = `ca_fixture_${toolkit}`;
    await append({ id: `connection:${toolkit}:sim-${step.index}:connected`, at: now().toISOString(), type: 'connection', toolkit, phase: 'connected' });
    // The connection callback lets the coach decide either way; during a call its guard keeps text quiet.
    if (!live) return runFollowUp(step);
    await settleFollowUps(deps, SIM_SESSION, store);
    // During a call the page tells the live model (app/page.tsx).
    const turn = await runTurn(step, 'voice_notice', `${live.callId}:connected-${toolkit}`, 'voice', {
      id: `voice-notice:${live.callId}:${toolkit}`,
      instruction: `The user just connected ${TOOLKIT_NAMES[toolkit]}, and the app confirmed it. Tell them briefly and offer to take a look for them.`,
    });
    if (turn.text) { await speakAs('assistant', turn.text); step.outputs.push(turn.text); }
  }

  async function tap(step: SimStep, control: SimControl, state: SessionProjection) {
    if (!pendingControls(state, { onCall: Boolean(live) }).includes(control)) return note(step, `tapped ${control}, which is not on screen`);
    const refused = (response: Response) => { if (!response.ok) note(step, `${control} was refused (HTTP ${response.status})`); };
    switch (control) {
      case 'answer_call': return startCall(step);
      case 'not_now_call': return refused(await callOffer(request('/api/voice/offer', 'DELETE')));
      case 'connect_gmail': return connect(step, 'gmail');
      case 'connect_calendar': return connect(step, 'calendar');
      case 'not_now_gmail':
      case 'not_now_calendar':
        return refused(await connections.decline(request('/api/connections/decline', 'POST', { toolkit: control === 'not_now_gmail' ? 'gmail' : 'calendar' })));
      case 'approve_task':
      case 'not_now_task': {
        const card = state.automations.find((item) => item.status === 'proposed')!;
        const body = control === 'approve_task' ? { action: 'approve', id: card.automationId, timezone: SIM_TIMEZONE } : { action: 'decline', id: card.automationId };
        return refused(await automations(request('/api/automations', 'POST', body)));
      }
    }
  }

  async function say(step: SimStep, text: string) {
    const turnId = `sim-${step.index}`;
    await append({ id: turnId, at: now().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: text.trim() });
    const turn = await runTurn(step, 'reply', turnId, 'text');
    if (!turn.text) return;
    await append({ id: `answer:${turnId}`, at: now().toISOString(), type: 'message', speaker: 'assistant', channel: 'text', text: turn.text });
    step.outputs.push(turn.text);
    // As the chat route does after the stream: the onboarding coach and the memory.
    await withTimeout(afterTurn(deps, SIM_SESSION, turnId), turnTimeoutMs, 'The after-turn agents');
  }

  /**
   * One utterance on the call. The persona's own ending applies to the first call only, so a callback
   * the app offers afterwards is measured as a call rather than cut again. The hang-up cuts the second
   * utterance, or the first one after it long enough to hold a thought; the line drops after the second
   * exchange. At the utterance cap the assistant's reply gets the app's wrap-up instruction first.
   */
  async function speak(step: SimStep, text: string) {
    const call = live!;
    call.utterances += 1;
    const first = call.ordinal === 1;
    if (first && persona.call === 'hangs_up_mid_sentence' && call.utterances >= 2 && text.trim().split(/\s+/).length >= MIN_WORDS_TO_CUT) {
      step.delivered = cutMidSentence(text);
      await speakAs('user', step.delivered);
      return endCall(step, 'user_hangup');
    }
    await speakAs('user', text);
    const last = call.utterances >= MAX_CALL_UTTERANCES;
    const turn = await runTurn(step, 'voice', `${call.callId}:turn-${call.utterances}`, 'voice',
      last ? { id: `voice-wrap-up:${call.callId}`, instruction: VOICE_LIMITS.wrapUp } : undefined);
    if (turn.text) { await speakAs('assistant', turn.text); step.outputs.push(turn.text); }
    if (first && persona.call === 'drops' && call.utterances === 2) return endCall(step, 'connection_lost');
    if (last) return endCall(step, 'remote_hangup');
  }

  async function apply(step: SimStep, action: SimAction, state: SessionProjection) {
    if (live) {
      if (action.type === 'speak') return speak(step, action.text);
      if (action.type === 'hang_up') return endCall(step, 'user_hangup');
      // Closing the page ends the call; nobody is left to read a follow-up.
      if (action.type === 'leave') return endCall(step, 'page_closed', false);
      if (action.type === 'tap') return tap(step, action.control, state);
      return note(step, 'typing during a call is not simulated; speak instead');
    }
    if (action.type === 'say') return say(step, action.text);
    if (action.type === 'tap') return tap(step, action.control, state);
    if (action.type === 'leave') return;
    return note(step, `${action.type} needs a live call`);
  }

  /** Run the app's side of a step; a failure marks the step incomplete and ends the conversation. */
  async function perform(step: SimStep, work: () => Promise<void>) {
    const started = Date.now();
    try { await work(); } catch (error) {
      step.incomplete = true;
      throw error;
    } finally {
      step.appLatencyMs += Date.now() - started;
      step.tools = step.turns.flatMap((turn) => turn.tools.map((tool) => ({ name: tool.name, input: tool.input })));
      step.connected = connectedNow();
    }
  }

  let errorSource: SimTrace['errorSource'];
  try {
    await append(greetingEvent(projectSession([]), now()));
    for (let index = 0; index < maxActions; index++) {
      const state = await project();
      const onCall = Boolean(live);
      const screen = live ? renderCallScreen(state, live.callId) : renderScreen(state);
      const asked = Date.now();
      let action: SimAction;
      try {
        action = await withTimeout(options.user.next({ persona, screen, onCall, turn: index + 1 }), userTimeoutMs, 'The simulated user');
      } catch (error) {
        errorSource = 'user';
        throw error;
      }
      const step: SimStep = { index, onCall, screen, action, outputs: [], turns: [], tools: [], connected: [], userLatencyMs: Date.now() - asked, appLatencyMs: 0 };
      steps.push(step);
      await perform(step, () => apply(step, action, state));
      if (action.type === 'leave') {
        status = 'left';
        leave = { feeling: action.feeling, reason: action.reason };
        break;
      }
    }
    // The action budget ran out mid-call: the harness ends the call naturally, and the app follows up.
    const last = steps.at(-1);
    if (live && last) await perform(last, () => endCall(last, 'remote_hangup'));
  } catch (error) {
    status = 'error';
    failure = errorText(error);
    errorSource ??= 'app';
  }
  // Copies: a turn abandoned by a timeout keeps running and may still append events or reads.
  const events = await store.readEvents();
  return {
    personaId: persona.id, promptVersion: PROMPT_VERSION, fixtureVersion: FIXTURE_VERSION, status,
    ...(leave ? { leave } : {}), ...(failure ? { error: failure, errorSource } : {}),
    steps, reads: [...composio.reads], events, finalProgress: projectSession(events).onboarding, durationMs: Date.now() - startedAt,
  };
}
