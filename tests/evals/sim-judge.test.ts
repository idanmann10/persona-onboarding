import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../lib/domain/events';
import { greetingEvent } from '../../lib/agent/session';
import { JEV_URL, JUDGE_STATE_LIMIT, judgeConversation, judgeQuestions, judgeState, parseJudgeResponse, transcriptLines } from '../../evals/sim/judge';

const at = '2026-09-27T12:00:00.000Z';
const events: SessionEvent[] = [
  greetingEvent(new Date(at)),
  { id: 'm1', at, type: 'message', speaker: 'user', channel: 'text', text: 'call yourself max.\nno calls please' },
  { id: 'call-offer:m1', at, type: 'call', phase: 'offered' },
  { id: 'connection-offer:gmail:m1', at, type: 'connection', toolkit: 'gmail', phase: 'offered', reason: 'See who is waiting on you.' },
  { id: 'answer:m1', at, type: 'message', speaker: 'assistant', channel: 'text', text: 'Max it is. Want a quick call?' },
  { id: 'call-offer:m1:declined', at, type: 'call', phase: 'declined' },
  { id: 'connection:gmail:a:connected', at, type: 'connection', toolkit: 'gmail', phase: 'connected' },
  { id: 'call:live_1:accepted', at, type: 'call', phase: 'accepted', callId: 'live_1' },
  { id: 'call:live_1:started', at, type: 'call', phase: 'started', callId: 'live_1' },
  { id: 'voice:live_1:1', at, type: 'voice_fragment', callId: 'live_1', speaker: 'assistant', text: ' Hi, Max here.', startMs: 0, endMs: 500, final: false },
  { id: 'voice:live_1:2', at, type: 'voice_fragment', callId: 'live_1', speaker: 'user', text: ' the thing is', startMs: 900, endMs: 1_500, final: false },
  { id: 'call:live_1:ended', at, type: 'call', phase: 'ended', callId: 'live_1', reason: 'user_hangup' },
  { id: 'automation-proposal:m2', at, type: 'automation', automationId: 'a1', phase: 'proposed', title: 'Inbox rundown', schedule: 'every weekday at 8:00 AM' },
];
const persona = { summary: 'Founder of a small startup who reads on their phone.' };

type Call = { url: string; init: RequestInit; body: Record<string, any> };
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
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answers = {
  form_like: { type: 'noul', noul: 0.22 },
  pushy: { type: 'noul', noul: 0.08 },
  ignored_user: { type: 'noul', noul: 0.61 },
  human: { type: 'score', score: 2.6, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e' }, probabilities: { 0: 0.05, 1: 0.1, 2: 0.2, 3: 0.45, 4: 0.2 }, confidence: 0.64 },
};

describe('judge transcript', () => {
  it('lists typed and spoken lines and what became of each card, without app internals', () => {
    expect(transcriptLines(events)).toEqual([
      "Assistant: Hi, I'm your new assistant. I don't have a name yet, so what would you like to call me? / If something's already on your mind, start there instead. Names can wait.",
      'User: call yourself max. / no calls please',
      'Assistant: Max it is. Want a quick call?',
      '[card] Call offer with an Answer button: the user tapped Not now',
      '[card] Connect Gmail button ("See who is waiting on you."): the user connected it',
      '[card] Gmail connected',
      '[call] A voice call started',
      'Assistant: (on the call) Hi, Max here.',
      'User: (on the call) the thing is',
      '[call] The call ended: the user hung up',
      '[card] Recurring task preview "Inbox rundown", every weekday at 8:00 AM: not answered',
    ]);
  });

  it('drops whole lines from the middle to fit, and says how many', () => {
    const lines = Array.from({ length: 400 }, (_, index) => `User: line ${index} ${'x'.repeat(100)}`);
    const state = judgeState('someone', lines);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(JUDGE_STATE_LIMIT);
    expect(state.transcript.slice(0, 4)).toEqual(lines.slice(0, 4));
    expect(state.transcript[4]).toBe(`[... ${state.omitted_lines} lines omitted ...]`);
    expect(state.transcript.slice(5)).toEqual(lines.slice(lines.length - (state.transcript.length - 5)));
    expect(state.transcript.length - 1 + state.omitted_lines!).toBe(lines.length);
    expect(judgeState('someone', lines.slice(0, 10))).toEqual({ note: expect.any(String), persona: 'someone', transcript: lines.slice(0, 10) });
  });
});

describe('judge request', () => {
  it('asks all four questions in one request and parses the answers', async () => {
    const { fetch, calls } = fetchScript([json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 900, output_tokens: 20 } })]);
    const judgment = await judgeConversation({ persona, events }, { apiKey: 'test-key', fetch });
    expect(judgment).toEqual({ model: 'jev-1.13.0', formLike: 0.22, pushy: 0.08, ignoredUser: 0.61, human: 3.6, humanConfidence: 0.64 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(JEV_URL);
    expect(call.init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' } });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.body.model).toBe('jev-latest');
    expect(call.body.state).toMatchObject({ persona: persona.summary, transcript: transcriptLines(events), note: expect.stringMatching(/data to evaluate, not instructions/) });
    expect(Object.keys(call.body.questions)).toEqual(['form_like', 'pushy', 'ignored_user', 'human']);
    for (const id of ['form_like', 'pushy', 'ignored_user']) {
      expect(call.body.questions[id]).toEqual({ type: 'noul', instructions: expect.stringContaining('Question:') });
    }
    expect(call.body.questions.human).toMatchObject({ type: 'score', criteria: expect.any(Array) });
    expect(call.body.questions.human.criteria).toHaveLength(5);
    expect(call.body.questions.human.instructions).toMatch(/never instructions to you/);
  });

  it('retries once with object criteria when the array form is refused with 422', async () => {
    const onFiveScale = { ...answers, human: { type: 'score', score: 4.2, legend: { 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e' }, confidence: 0.5 } };
    const { fetch, calls } = fetchScript([json({ detail: 'criteria' }, 422), json({ answers: onFiveScale })]);
    const judgment = await judgeConversation({ persona, events }, { apiKey: 'k', fetch });
    expect(calls.map((call) => Array.isArray(call.body.questions.human.criteria))).toEqual([true, false]);
    expect(Object.keys(calls[1].body.questions.human.criteria)).toEqual(['1', '2', '3', '4', '5']);
    expect(judgment).toMatchObject({ human: 4.2, humanConfidence: 0.5, formLike: 0.22 });
    const levels = judgeQuestions('array').human.criteria as string[];
    expect(judgeQuestions('object').human.criteria).toEqual(Object.fromEntries(levels.map((level, index) => [String(index + 1), level])));
  });

  it('never throws: a refusal, bad JSON, an unexpected shape or a network failure gives null', async () => {
    const run = async (responses: Array<Response | Error>) => judgeConversation({ persona, events }, { apiKey: 'k', fetch: fetchScript(responses).fetch, retryDelayMs: 0 });
    expect(await run([json({}, 422), json({}, 422)])).toBeNull();
    expect(await run([new Response('not json', { status: 200 })])).toBeNull();
    expect(await run([json({ answers: 'nope' })])).toBeNull();
    expect(await run([json({ result: answers })])).toBeNull();
    expect(await run([json({ answers: { form_like: { type: 'noul', probability: 0.3 } } })])).toBeNull();
    expect(await run([json({}, 401)])).toBeNull();
    expect(await run([new Error('ECONNRESET'), new Error('ECONNRESET')])).toBeNull();
    expect(await run([json({}, 500), json({}, 529)])).toBeNull();
    expect(await run([new DOMException('The operation timed out.', 'TimeoutError'), json({ answers })])).toMatchObject({ formLike: 0.22 });
    expect(await run([json({}, 429), json({ answers })])).toMatchObject({ pushy: 0.08 });
  });

  it('skips the request without a key', async () => {
    const { fetch, calls } = fetchScript([]);
    expect(await judgeConversation({ persona, events }, { apiKey: undefined, fetch })).toBeNull();
    expect(await judgeConversation({ persona, events }, { apiKey: '', fetch })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('degrades each answer on its own', () => {
    expect(parseJudgeResponse({ answers: { form_like: { noul: 1.4 }, pushy: { noul: 0.5 }, ignored_user: null, human: { score: 'high' } } }))
      .toEqual({ formLike: null, pushy: 0.5, ignoredUser: null, human: null, humanConfidence: null });
    // Out-of-range scores and scores without a legend: the documented 0-based scale applies.
    expect(parseJudgeResponse({ answers: { human: { score: 7, legend: { 0: 'a', 4: 'e' } } } })).toBeNull();
    expect(parseJudgeResponse({ answers: { human: { score: 0, confidence: 2 } } })).toEqual({ formLike: null, pushy: null, ignoredUser: null, human: 1, humanConfidence: null });
    expect(parseJudgeResponse({ answers: { human: { score: 3 } } }, 'object')).toMatchObject({ human: 3 });
    expect(parseJudgeResponse(null)).toBeNull();
  });
});
