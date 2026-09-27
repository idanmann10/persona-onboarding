import { describe, expect, it } from 'vitest';
import { loadPersonas, parsePersonas } from '../../evals/sim/personas';
import raw from '../../evals/sim/personas.json';
import {
  ANTHROPIC_URL, THINKING_MAX_TOKENS, buildUserSystemPrompt, buildUserTurnPrompt, createClaudeUser, createScriptedUser, extractJsonObject, parseSimAction,
  type SimUserInput,
} from '../../evals/sim/user';

const personas = loadPersonas();
const persona = (id: string) => personas.find((item) => item.id === id)!;
const input = (overrides: Partial<SimUserInput> = {}): SimUserInput => ({ persona: persona('busy_founder'), screen: 'Persona app. Chat with Persona.\n\nPersona: Hi!', onCall: false, turn: 1, ...overrides });

type Call = { url: string; init: RequestInit; body: { model: string; max_tokens: number; thinking?: unknown; system: string; messages: Array<{ role: string; content: string }> } };
function fetchScript(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const reply = (text: string, status = 200) => new Response(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 120, output_tokens: 15 } }), { status });
const status = (code: number) => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'try later' } }), { status: code });

describe('personas', () => {
  it('ships the sixteen personas, each valid', () => {
    expect(personas.map((item) => item.id)).toEqual([
      'busy_founder', 'privacy_skeptic', 'name_refuser', 'task_first', 'hangs_up_mid_sentence', 'dropped_call', 'call_hater', 'explorer',
      'one_word', 'chatty_overshare', 'rule_breaker', 'spanish_speaker', 'calendar_person', 'burned_before', 'gmail_decliner', 'executive_assistant',
    ]);
    expect(persona('spanish_speaker').language).toBe('es');
    expect(persona('busy_founder').language).toBe('en');
    expect(persona('burned_before').patience).toBe(2);
    expect(persona('gmail_decliner')).toMatchObject({ gmail: 'never', recurring: 'open' });
    expect(persona('calendar_person')).toMatchObject({ gmail: 'never', calendar: 'connects' });
    expect(persona('hangs_up_mid_sentence').call).toBe('hangs_up_mid_sentence');
    expect(persona('dropped_call').call).toBe('drops');
  });

  it('rejects duplicates and out-of-range fields', () => {
    expect(() => parsePersonas([...raw, raw[0]])).toThrow('Duplicate persona ID: busy_founder');
    expect(() => parsePersonas([{ ...raw[0], patience: 9 }])).toThrow();
    expect(() => parsePersonas([{ ...raw[0], call: 'maybe' }])).toThrow();
    expect(() => parsePersonas([{ ...raw[0], mood: 'grumpy' }])).toThrow();
  });
});

describe('simulated user prompt', () => {
  it('describes the person, their rules, their patience and the actions, and only what is on screen', () => {
    const prompt = buildUserSystemPrompt(persona('privacy_skeptic'));
    expect(prompt).toContain(persona('privacy_skeptic').summary);
    expect(prompt).toContain(persona('privacy_skeptic').goal);
    expect(prompt).toContain('after 4 assistant replies in a row that don\'t help you');
    expect(prompt).toContain('Gmail: You connect Gmail only after the assistant gives a specific, believable reason');
    expect(prompt).toContain("Calls: You don't want a voice call.");
    expect(prompt).toContain('Recurring tasks: You are wary of anything that runs on its own.');
    expect(prompt).toContain('You only know what is on your screen.');
    expect(prompt).toContain('{"type":"tap","control":"<a button id listed on screen');
    expect(prompt).toContain('{"type":"hang_up"}');
    expect(buildUserSystemPrompt(persona('spanish_speaker'))).toContain('Write and speak only in Spanish. Never switch languages');
    expect(prompt).toContain('treat it as your own mail and schedule');
    expect(buildUserTurnPrompt(input({ onCall: true, turn: 4 }))).toMatch(/^You are on a live voice call in the app\.\n<screen>\n[\s\S]*\n<\/screen>\nSpeak, hang up/);
    expect(buildUserTurnPrompt(input({ turn: 4 }))).not.toMatch(/turn|4/i);
  });
});

describe('Claude user', () => {
  it('sends the persona and the screen to the Messages API and parses the action', async () => {
    const { fetch, calls } = fetchScript([reply('Sure.\n```json\n{"type":"say","text":"max. inbox is chaos"}\n```')]);
    const user = createClaudeUser({ apiKey: 'sk-test-secret', fetch });
    expect(await user.next(input())).toEqual({ type: 'say', text: 'max. inbox is chaos' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(ANTHROPIC_URL);
    expect(call.init).toMatchObject({ method: 'POST', headers: { 'x-api-key': 'sk-test-secret', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.body).toEqual({
      model: 'claude-sonnet-5', max_tokens: 500, thinking: { type: 'disabled' }, system: buildUserSystemPrompt(persona('busy_founder')),
      messages: [{ role: 'user', content: buildUserTurnPrompt(input()) }],
    });
    expect(user.usage).toEqual({ requests: 1, inputTokens: 120, outputTokens: 15 });
  });

  it('asks again at the model default, with room to think, when the model cannot turn thinking off', async () => {
    const refusedOff = new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking.type: "disabled" is not supported for this model' } }), { status: 400 });
    const { fetch, calls } = fetchScript([refusedOff, reply('{"type":"say","text":"hi"}'), reply('{"type":"say","text":"again"}')]);
    const user = createClaudeUser({ apiKey: 'k', fetch, retryDelayMs: 0 });
    expect(await user.next(input())).toEqual({ type: 'say', text: 'hi' });
    expect(await user.next(input({ turn: 2 }))).toEqual({ type: 'say', text: 'again' });
    expect(calls.map((call) => [call.body.max_tokens, 'thinking' in call.body])).toEqual([[500, true], [THINKING_MAX_TOKENS, false], [THINKING_MAX_TOKENS, false]]);
  });

  it('retries a reply that has no text, such as thinking that used the whole budget', async () => {
    const thoughtOnly = () => new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: '' }], stop_reason: 'max_tokens', usage: { input_tokens: 100, output_tokens: 500 } }), { status: 200 });
    const retried = fetchScript([thoughtOnly(), reply('{"type":"leave","feeling":"neutral","reason":"done"}')]);
    expect(await createClaudeUser({ apiKey: 'k', fetch: retried.fetch, retryDelayMs: 0 }).next(input())).toMatchObject({ type: 'leave' });
    const never = fetchScript([thoughtOnly(), thoughtOnly(), thoughtOnly()]);
    await expect(createClaudeUser({ apiKey: 'k', fetch: never.fetch, retryDelayMs: 0 }).next(input())).rejects.toThrow('no reply text (stop_reason max_tokens)');
  });

  it('retries rate limits, server errors and timeouts twice, then gives up without leaking the key', async () => {
    const retried = fetchScript([status(429), new DOMException('The operation timed out.', 'TimeoutError'), reply('{"type":"tap","control":"connect_gmail"}')]);
    expect(await createClaudeUser({ apiKey: 'k', fetch: retried.fetch, retryDelayMs: 0 }).next(input())).toEqual({ type: 'tap', control: 'connect_gmail' });
    expect(retried.calls).toHaveLength(3);

    const down = fetchScript([status(500), status(503), status(529)]);
    await expect(createClaudeUser({ apiKey: 'sk-test-secret', fetch: down.fetch, retryDelayMs: 0 }).next(input())).rejects.toThrow('Anthropic API failed after 3 attempts (HTTP 529)');

    const refused = fetchScript([status(401)]);
    const error = await createClaudeUser({ apiKey: 'sk-test-secret', fetch: refused.fetch, retryDelayMs: 0 }).next(input()).catch((cause: Error) => cause);
    expect(refused.calls).toHaveLength(1);
    expect(String(error)).toMatch(/Anthropic API HTTP 401/);
    expect(String(error)).not.toContain('sk-test-secret');
  });

  it('asks once more with a correction note when the reply is not a valid action', async () => {
    const { fetch, calls } = fetchScript([reply('I think I would say hello.'), reply('{"type":"say","text":"hello"}')]);
    expect(await createClaudeUser({ apiKey: 'k', fetch }).next(input())).toEqual({ type: 'say', text: 'hello' });
    expect(calls[1].body.messages[0].content).toContain('Your last reply could not be used (no JSON object in the reply)');

    const stubborn = fetchScript([reply('{"type":"tap","control":"press_everything"}'), reply('{"type":"dance"}')]);
    await expect(createClaudeUser({ apiKey: 'k', fetch: stubborn.fetch }).next(input())).rejects.toThrow(/no valid action twice/);
    expect(stubborn.calls[1].body.messages[0].content).toContain('control:');
  });

  it('maps talking to the current mode, and refuses a hang-up with no call', async () => {
    const onCall = fetchScript([reply('{"type":"say","text":"yeah so"}')]);
    expect(await createClaudeUser({ apiKey: 'k', fetch: onCall.fetch }).next(input({ onCall: true }))).toEqual({ type: 'speak', text: 'yeah so' });
    const offCall = fetchScript([reply('{"type":"hang_up"}'), reply('{"type":"leave","feeling":"bored","reason":"nothing useful"}')]);
    expect(await createClaudeUser({ apiKey: 'k', fetch: offCall.fetch }).next(input())).toEqual({ type: 'leave', feeling: 'bored', reason: 'nothing useful' });
    expect(offCall.calls[1].body.messages[0].content).toContain('There is no call to hang up');
  });
});

describe('actions', () => {
  it('finds the JSON object in a chatty reply, even with braces inside strings', () => {
    expect(extractJsonObject('Okay! {"type":"say","text":"use {curly} and \\"quotes\\""} done')).toEqual({ type: 'say', text: 'use {curly} and "quotes"' });
    expect(extractJsonObject('{broken {"type":"hang_up"}')).toEqual({ type: 'hang_up' });
    expect(() => extractJsonObject('no json here')).toThrow('no JSON object');
  });

  it('validates each action type', () => {
    expect(parseSimAction({ type: 'say', text: '  hi  ' }, false)).toEqual({ ok: true, action: { type: 'say', text: 'hi' } });
    expect(parseSimAction({ type: 'speak', text: 'hi' }, false)).toEqual({ ok: true, action: { type: 'say', text: 'hi' } });
    expect(parseSimAction({ type: 'say', text: '' }, false).ok).toBe(false);
    expect(parseSimAction({ type: 'leave', feeling: 'furious', reason: 'x' }, false).ok).toBe(false);
    expect(parseSimAction({ type: 'tap', control: 'approve_task' }, true)).toEqual({ ok: true, action: { type: 'tap', control: 'approve_task' } });
  });

  it('plays a script back, passes what the user sees to functions, and leaves when it runs out', async () => {
    const user = createScriptedUser([{ type: 'say', text: 'hi' }, (seen) => ({ type: 'say', text: `turn ${seen.turn}` })]);
    expect(await user.next(input())).toEqual({ type: 'say', text: 'hi' });
    expect(await user.next(input({ turn: 2 }))).toEqual({ type: 'say', text: 'turn 2' });
    expect(await user.next(input({ turn: 3 }))).toEqual({ type: 'leave', feeling: 'neutral', reason: 'script finished' });
    expect(user.seen.map((seen) => seen.turn)).toEqual([1, 2, 3]);
  });
});
