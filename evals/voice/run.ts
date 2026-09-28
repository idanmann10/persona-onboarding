/**
 * Voice replay: a real GPT-Live session over WebSocket, built from the app's own call config (instructions,
 * seeded history, hello, delegation and tools), with the caller played by text-to-speech. Tool calls run
 * through the same code as /api/voice/tool against a scripted conversation in the local database. It checks
 * what a microphone test would: the hello comes first and has a goal, the Connect button is really put up
 * before it's mentioned, background noise doesn't get a reply, and a goodbye hangs up.
 *
 *   bun --env-file=.env.local evals/voice/run.ts [--id <scenario>]
 *
 * Needs OPENAI_API_KEY with GPT-Live access and a local DATABASE_URL. Costs real GPT-Live minutes (about one
 * a scenario) and a little text-to-speech; TTS audio is cached under evals/results/tts.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createStore } from '../../lib/db/store';
import { getDatabase } from '../../lib/db/client';
import { projectSession } from '../../lib/domain/project';
import type { SessionEvent } from '../../lib/domain/events';
import { buildLiveSession } from '../../lib/voice/session-config';
import { isFarewell } from '../../lib/voice/events';
import { capToolResult, runVoiceTool, toolContext } from '../../lib/agent/tools';

const RATE = 24_000;
const FRAME_MS = 20;
const FRAME_BYTES = (RATE * FRAME_MS / 1000) * 2;
const QUIET_MS = 1_600;
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY is required');

type Turn = { say?: string; noise?: { ms: number; voice?: string } };
interface Scenario {
  id: string;
  title: string;
  facts: Record<string, string>;
  history?: Array<[speaker: 'user' | 'assistant', text: string]>;
  /** A recurring task waiting for approval before the call starts. */
  waitingTask?: boolean;
  turns: Turn[];
  check(result: Result): string[];
}
interface Result { lines: Array<{ who: 'assistant' | 'user' | 'tool' | 'noise'; text: string; at: number }>; tools: Array<{ name: string; args: string; status: string; at: number }>; greetingAt?: number; endedByTool: boolean }

const said = (result: Result) => result.lines.filter((line) => line.who === 'assistant').map((line) => line.text);
const SCENARIOS: Scenario[] = [
  {
    id: 'hello_back', title: 'The assistant speaks first with a goal; a bare "hello" back gets the next ask, not just "hi"',
    facts: { assistant_name: 'Max' }, history: [['assistant', "hey Idan, what should I call myself?"], ['user', 'Max'], ['assistant', 'Max it is. Tap Answer if a quick call is easier.']],
    turns: [{ say: 'Hello?' }],
    check: (result) => {
      const replies = said(result);
      const issues: string[] = [];
      if (!result.greetingAt || result.greetingAt > 3_000) issues.push(`hello started ${result.greetingAt ?? 'never'} ms in (want under 3000)`);
      if (!/\?/.test(replies[0] ?? '')) issues.push('the hello asked nothing');
      const after = replies.slice(1).join(' ');
      if (!after || after.replace(/[^a-z]/gi, '').length < 12) issues.push(`after "hello" it said only: "${after}"`);
      return issues;
    },
  },
  {
    id: 'gmail_yes', title: 'Saying yes to a look at the inbox puts the Connect button up before it is mentioned',
    facts: { assistant_name: 'Pip', preferred_name: 'Idan', current_need: 'investor updates eat my Mondays' },
    turns: [{ say: 'uh, sure' }],
    check: (result) => {
      const shown = result.tools.find((tool) => tool.name === 'show_connection' && /shown/.test(tool.status));
      const claim = result.lines.find((line) => line.who === 'assistant' && /button|tap/i.test(line.text) && line.at > (result.greetingAt ?? 0) + 500);
      if (!shown) return ['no show_connection call'];
      if (claim && claim.at < shown.at) return ['mentioned the button before the backend put it up'];
      return [];
    },
  },
  {
    id: 'noise', title: 'Background noise and a distant voice get no reply',
    facts: { assistant_name: 'Pip', preferred_name: 'Idan', current_need: 'investor updates eat my Mondays' },
    turns: [{ noise: { ms: 3_500, voice: 'Did you see the game last night? It went to overtime.' } }, { noise: { ms: 3_000 } }],
    check: (result) => {
      const noiseAt = result.lines.find((line) => line.who === 'noise')?.at ?? Infinity;
      const reply = result.lines.find((line) => line.who === 'assistant' && line.at > noiseAt + 300 && line.at < noiseAt + 16_000);
      return reply ? [`answered the noise: "${reply.text}"`] : [];
    },
  },
  {
    id: 'approve_by_voice', title: 'A spoken yes turns the waiting recurring task on, no tap needed',
    facts: { assistant_name: 'Pip', preferred_name: 'Idan', current_need: 'investor updates eat my Mondays' },
    history: [['assistant', 'Want a weekday 8:30 rundown of investor emails waiting on you? The card is below.']],
    waitingTask: true,
    turns: [{ say: 'Yes, set it up.' }],
    check: (result) => {
      const on = result.tools.find((tool) => /approve_automation|propose_automation/.test(tool.name) && tool.status === 'approved');
      const tapAsk = result.lines.find((line) => line.who === 'assistant' && /tap approve|hit approve|approve (it|the card)/i.test(line.text));
      return [...(on ? [] : ['the task was not turned on']), ...(tapAsk ? [`still asked for a tap: "${tapAsk.text}"`] : [])];
    },
  },
  {
    id: 'bye', title: 'A goodbye gets a short goodbye and end_call',
    facts: { assistant_name: 'Pip', preferred_name: 'Idan', current_need: 'investor updates eat my Mondays' },
    turns: [{ say: 'Okay, that is all for now. Bye!' }],
    check: (result) => {
      if (result.endedByTool) return [];
      // The page's backup: a short turn that ends on a goodbye, answered, then quiet, closes the call.
      const heard = result.lines.filter((line) => line.who === 'user').at(-1);
      const answered = heard && result.lines.some((line) => line.who === 'assistant' && line.at > heard.at);
      return heard && isFarewell(heard.text) && answered ? [] : ['no end_call and the backup hang-up would not fire'];
    },
  },
];

/** The caller's line as 24 kHz PCM16 mono, from OpenAI text-to-speech, cached on disk. */
async function speech(text: string, voice = 'alloy'): Promise<Buffer> {
  const dir = 'evals/results/tts';
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${createHash('sha1').update(`${voice}:${text}`).digest('hex').slice(0, 16)}.pcm`;
  if (existsSync(file)) return readFileSync(file);
  for (const model of ['gpt-4o-mini-tts', 'tts-1']) {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice, input: text, response_format: 'pcm' }),
    });
    if (!response.ok) continue;
    const audio = Buffer.from(await response.arrayBuffer());
    writeFileSync(file, audio);
    return audio;
  }
  throw new Error('Text-to-speech failed');
}

/** A real microphone is never digitally silent: a faint noise floor between the caller's lines. */
function roomTone(): Buffer {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let index = 0; index < FRAME_BYTES; index += 2) frame.writeInt16LE(Math.round((Math.random() * 2 - 1) * 30), index);
  return frame;
}

/** Low room noise with an optional distant voice mixed in at a fifth of its level. */
async function noise(ms: number, voiceLine?: string): Promise<Buffer> {
  const samples = Math.round(RATE * ms / 1000);
  const out = Buffer.alloc(samples * 2);
  const voice = voiceLine ? await speech(voiceLine, 'onyx') : undefined;
  for (let index = 0; index < samples; index++) {
    let value = (Math.random() * 2 - 1) * 900;
    if (voice && index * 2 + 1 < voice.length) value += voice.readInt16LE(index * 2) * 0.2;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), index * 2);
  }
  return out;
}

async function run(scenario: Scenario): Promise<Result> {
  const store = createStore(getDatabase());
  const sessionId = crypto.randomUUID();
  await store.createSession(sessionId);
  let clock = Date.now() - 60_000;
  const at = () => new Date((clock += 1_000)).toISOString();
  const events: SessionEvent[] = [
    { id: 'f:user_given_name', at: at(), type: 'fact', key: 'user_given_name', value: 'Idan', evidence: 'tentative', provenance: 'tool_observed', sourceEventId: 'signin' },
    ...Object.entries(scenario.facts).map(([key, value]): SessionEvent => ({ id: `f:${key}`, at: at(), type: 'fact', key, value, evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'x' })),
    ...(scenario.history ?? []).map(([speaker, text], index): SessionEvent => ({ id: `m:${index}`, at: at(), type: 'message', speaker, channel: 'text', text })),
  ];
  for (const event of events) await store.appendEvent(sessionId, event);
  if (scenario.waitingTask) {
    const automationId = crypto.randomUUID();
    await store.proposeAutomation(sessionId, { id: automationId, title: 'Morning investor rundown', instruction: 'List investor emails waiting on my reply, newest first.', toolkits: ['gmail'], cadence: 'weekdays', time: '08:30' });
    await store.appendEvent(sessionId, { id: `automation-proposal:${automationId}`, at: at(), type: 'automation', automationId, phase: 'proposed', title: 'Morning investor rundown', schedule: 'every weekday at 8:30 AM', instruction: 'List investor emails waiting on my reply, newest first.' });
  }
  const callId = `live_replay_${Date.now()}`;
  await store.appendEvent(sessionId, { id: `call:${callId}:accepted`, at: at(), type: 'call', phase: 'accepted', callId });

  const live = buildLiveSession(projectSession(await store.readEvents(sessionId)), process.env, { gmail: true, calendar: true });
  const session = { ...live.session, audio: { ...live.session.audio, format: { type: 'audio/pcm', rate: RATE } } };
  const result: Result = { lines: [], tools: [], endedByTool: false };
  const started = Date.now();
  const now = () => Date.now() - started;
  let lastAssistant = 0;
  let assistantSpoke = false;
  const outgoing: Buffer[] = [];
  const delegations = new Map<string, { calls: Array<Promise<{ callId: string; output: string }>>; done: boolean }>();
  let saving: Promise<unknown> = Promise.resolve();

  // Bun's WebSocket takes headers.
  const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${key}` } } as unknown as string[]);
  const send = (event: Record<string, unknown>) => ws.readyState === 1 && ws.send(JSON.stringify(event));
  const closed = new Promise<void>((resolve) => { ws.onclose = () => resolve(); });
  let pump: ReturnType<typeof setInterval> | undefined;

  const ready = new Promise<void>((resolve, reject) => {
    ws.onopen = () => send({ type: 'session.start', event_id: 'start', session });
    ws.onerror = (error) => reject(error);
    ws.onmessage = async ({ data }) => {
      const event = JSON.parse(String(data)) as Record<string, unknown>;
      if (event.type === 'session.started') {
        // Keep audio flowing (silence unless the caller is speaking), then say the hello at once, as the page does.
        pump = setInterval(() => {
          const frame = outgoing.shift() ?? roomTone();
          send({ type: 'session.input_audio.append', audio: frame.toString('base64') });
        }, FRAME_MS);
        send({ type: 'session.commentary.append', event_id: 'hello', delegation_id: null, content: live.greetingLine });
        resolve();
      } else if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
        result.greetingAt ??= now();
        lastAssistant = now();
        assistantSpoke = true;
        const last = result.lines.at(-1);
        if (last?.who === 'assistant' && now() - last.at < 2_500) { last.text += event.delta; last.at = now(); }
        else result.lines.push({ who: 'assistant', text: event.delta, at: now() });
      } else if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
        // What they said is stored as the page stores it, so a tool's check of their own words sees it.
        saving = saving.then(() => store.appendEvent(sessionId, { id: `vf:${String(event.event_id)}`, at: new Date().toISOString(), type: 'voice_fragment', text: String(event.delta), final: true, callId, speaker: 'user', startMs: Number(event.start_ms) || 0, endMs: Number(event.end_ms) || 0 })).catch(() => undefined);
        const last = result.lines.at(-1);
        if (last?.who === 'user') last.text += event.delta; else result.lines.push({ who: 'user', text: event.delta, at: now() });
      } else if (event.type === 'response.event') {
        const inner = (event.event ?? {}) as Record<string, unknown>;
        const id = String(event.delegation_id ?? 'default');
        const delegation = delegations.get(id) ?? { calls: [], done: false };
        delegations.set(id, delegation);
        if (inner.type === 'response.output_item.done' && (inner.item as { type?: string })?.type === 'function_call') {
          const item = inner.item as { name: string; arguments: string; call_id: string };
          delegation.calls.push((async () => {
            await saving;
            const state = projectSession(await store.readEvents(sessionId));
            const ctx = await toolContext({ store, env: process.env }, sessionId, state, { channel: 'voice', turnId: `${callId}:${item.call_id}` });
            const { output } = await runVoiceTool(ctx, item.name, JSON.parse(item.arguments || '{}'));
            result.tools.push({ name: item.name, args: item.arguments, status: String(output.status), at: now() });
            if (item.name === 'end_call') result.endedByTool = true;
            return { callId: item.call_id, output: capToolResult(output) };
          })());
        } else if (['response.completed', 'response.done', 'response.incomplete'].includes(String(inner.type)) && delegation.calls.length && !delegation.done) {
          delegation.done = true;
          const outputs = await Promise.all(delegation.calls);
          delegations.delete(id);
          for (const output of outputs) send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: output.callId, output: output.output } });
          send({ type: 'response.create' });
        }
      } else if (event.type === 'error') {
        console.error('  live error:', JSON.stringify(event).slice(0, 300));
      }
    };
  });

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Until the assistant has spoken and then been quiet for a moment (or a cap). */
  const settle = async (cap = 14_000) => {
    const from = now();
    while (now() - from < cap) {
      await wait(200);
      if (assistantSpoke && now() - lastAssistant > QUIET_MS && outgoing.length === 0 && ![...delegations.values()].some((item) => item.calls.length && !item.done)) return;
    }
  };
  const queue = (audio: Buffer) => { for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) outgoing.push(audio.subarray(offset, Math.min(audio.length, offset + FRAME_BYTES))); };

  await ready;
  await settle();
  for (const turn of scenario.turns) {
    if (result.endedByTool) break;
    assistantSpoke = false;
    if (turn.say) { result.lines.push({ who: 'tool', text: `(caller says) ${turn.say}`, at: now() }); queue(await speech(turn.say)); }
    if (turn.noise) { result.lines.push({ who: 'noise', text: `(${turn.noise.ms} ms of room noise${turn.noise.voice ? ' and a distant voice' : ''})`, at: now() }); queue(await noise(turn.noise.ms, turn.noise.voice)); }
    while (outgoing.length) await wait(100);
    await settle(turn.noise ? 12_000 : 14_000);
    if (!turn.noise && isFarewell(turn.say ?? '')) await wait(2_000);
  }
  // Whatever it says after a tool result ("it's on your screen now") comes after the backend's response.
  if (result.tools.length && !result.endedByTool) { assistantSpoke = false; await settle(8_000); }
  clearInterval(pump);
  send({ type: 'session.close' });
  await Promise.race([closed, wait(8_000)]);
  await store.deleteSession(sessionId);
  return result;
}

const only = process.argv.includes('--id') ? process.argv[process.argv.indexOf('--id') + 1] : undefined;
let failures = 0;
for (const scenario of SCENARIOS.filter((item) => !only || item.id === only)) {
  console.log(`\n▶ ${scenario.id}: ${scenario.title}`);
  const result = await run(scenario);
  for (const line of result.lines) console.log(`  ${String(line.at).padStart(6)} ms  ${line.who === 'assistant' ? 'assistant' : line.who === 'user' ? 'heard   ' : '         '}  ${line.text.trim()}`);
  for (const tool of result.tools) console.log(`  ${String(tool.at).padStart(6)} ms  tool       ${tool.name}(${tool.args.slice(0, 80)}) -> ${tool.status}`);
  const issues = scenario.check(result);
  // Every scenario: never say a button is up without the backend having put one up first.
  const shownAt = result.tools.find((tool) => tool.name === 'show_connection' && /shown/.test(tool.status))?.at ?? Infinity;
  const claim = result.lines.find((line) => line.who === 'assistant' && /(put|pulled|popped) (the |a )?(connect|gmail)?\s*button|button (is )?(up|below|on your screen)/i.test(line.text) && line.at < shownAt);
  if (claim && !result.tools.some((tool) => tool.name === 'show_connection')) issues.push(`claimed a button with no show_connection: "${claim.text.trim().slice(0, 90)}"`);
  failures += issues.length ? 1 : 0;
  console.log(issues.length ? `  ✗ ${issues.join('; ')}` : '  ✓ pass');
}
process.exit(failures ? 1 : 0);
