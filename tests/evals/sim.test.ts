import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { loadPersonas, type Persona } from '../../evals/sim/personas';
import { cutMidSentence, fragmentChunks, simulate, withTimeout } from '../../evals/sim/run';
import { createScriptedUser, type SimAction } from '../../evals/sim/user';
import { scoreTrace, simInvariants, valueMention } from '../../evals/sim/score';

type Reply = { text?: string; call?: { name: string; input: Record<string, unknown> }; fail?: string; hang?: boolean };

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
let callSeq = 0;

/** A model that plays back a script: each reply is one model step (a tool call or final text). */
function scripted(replies: Reply[]) {
  const queue = [...replies];
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const reply = queue.shift();
      if (!reply) throw new Error('the script ran out of model replies');
      if (reply.fail) throw new Error(reply.fail);
      if (reply.hang) return new Promise<never>(() => undefined);
      return reply.call
        ? { content: [{ type: 'tool-call' as const, toolCallId: `c${++callSeq}`, toolName: reply.call.name, input: JSON.stringify(reply.call.input) }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] }
        : { content: [{ type: 'text' as const, text: reply.text ?? '' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] };
    },
  });
  return { model, prompts, remaining: () => queue.length };
}

const personas = loadPersonas();
const persona = (id: string): Persona => personas.find((item) => item.id === id)!;
const say = (text: string): SimAction => ({ type: 'say', text });
const speak = (text: string): SimAction => ({ type: 'speak', text });
const tap = (control: Extract<SimAction, { type: 'tap' }>['control']): SimAction => ({ type: 'tap', control });
const leave = (feeling: Extract<SimAction, { type: 'leave' }>['feeling'] = 'satisfied'): SimAction => ({ type: 'leave', feeling, reason: 'done' });

describe('simulated conversation', () => {
  it('names the assistant, answers the call card, hangs up mid-sentence, and gets a follow-up about it', async () => {
    const script = scripted([
      { call: { name: 'remember', input: { key: 'assistant_name', value: 'Max' } } },
      { text: "Max it is. Want to hop on a quick call? It's faster than typing." },
      { call: { name: 'offer_call', input: {} } },
      { text: "Tap Answer when you're ready." },
      { text: "Hey, it's Max, picking up from the chat. What should I call you?" },
      { call: { name: 'remember', input: { key: 'preferred_name', value: 'Jordan' } } },
      { text: 'Nice to meet you, Jordan. What would you love a hand with?' },
      { text: 'Looks like we got cut off. You were telling me about the Friday vendor update. Want me to help chase those numbers?' },
    ]);
    const original = 'Honestly the Friday vendor update, every single week I have to chase five people for their numbers.';
    const user = createScriptedUser([say('Call yourself Max'), say('sure, a quick call works'), tap('answer_call'), speak("I'm Jordan"), speak(original), leave()]);
    const trace = await simulate(persona('hangs_up_mid_sentence'), { user, model: script.model });

    expect(trace).toMatchObject({ status: 'left', leave: { feeling: 'satisfied' } });
    expect(script.remaining()).toBe(0);
    // The session starts like the app's, and the call card offers the Answer control.
    expect(trace.events[0]).toMatchObject({ type: 'message', origin: 'greeting' });
    expect(user.seen[2].screen).toContain('[Card] Max is ready to call');
    expect(user.seen[2].screen).toContain('Buttons you can tap: answer_call, not_now_call');

    // Answering starts the call, and the app's greeting instruction produces the first spoken line.
    const answer = trace.steps[2];
    expect(answer.turns[0]).toMatchObject({ kind: 'voice_greeting', channel: 'voice', trigger: 'voice-greeting:live_sim_1' });
    expect(script.prompts[4]).toContain('Greet the caller now in English, as Max');
    expect(answer.outputs).toEqual(["Hey, it's Max, picking up from the chat. What should I call you?"]);
    expect(user.seen[3]).toMatchObject({ onCall: true });
    expect(user.seen[3].screen).toContain("--- Live call with Max ---\nMax: Hey, it's Max, picking up from the chat. What should I call you?");
    expect(user.seen[3].screen).toContain('(You are on a call. Speak, or hang up.)');

    // A name said on the call goes through the real gate: it is in the user's own words.
    expect(trace.steps[3].turns[0].tools[0]).toMatchObject({ name: 'remember', output: { status: 'saved', evidence: 'confirmed' } });

    // The harness cuts the second utterance mid-sentence and hangs up for the user.
    const hangup = trace.steps[4];
    expect(hangup.delivered).toBe(cutMidSentence(original));
    expect(hangup.delivered!.length).toBeLessThan(original.length * 0.7);
    expect(hangup.delivered).not.toMatch(/[.?!,]$/);
    expect(hangup).toMatchObject({ callEnded: 'user_hangup', followUp: 'message' });
    expect(trace.events).toContainEqual(expect.objectContaining({ id: 'call:live_sim_1:ended', phase: 'ended', reason: 'user_hangup' }));
    const lastUserLine = trace.events.filter((event) => event.type === 'voice_fragment' && event.speaker === 'user').at(-1);
    expect(lastUserLine).toMatchObject({ text: ` ${hangup.delivered}` });
    // The follow-up is the app's trigger, and it knows the sentence was cut off.
    expect(hangup.turns[0]).toMatchObject({ kind: 'follow_up', trigger: 'followup:call:live_sim_1', shown: true });
    expect(script.prompts[7]).toContain('may have been cut off mid-sentence');
    expect(hangup.outputs[0]).toMatch(/cut off/);
    expect(trace.events).toContainEqual(expect.objectContaining({ type: 'decision', trigger: 'followup:call:live_sim_1', outcome: 'messaged' }));
    expect(user.seen[5].screen).toContain('· You hung up]');

    expect(scoreTrace(trace)).toMatchObject({ named: true, knowsUser: true, callOffered: true, callHappened: true, stayed: true, firstValue: false, activated: false, turns: 6 });
    expect(simInvariants(trace).filter((check) => !check.passed)).toEqual([]);
  });

  it('connects Gmail, reads it in the follow-up and counts the finding as first value', async () => {
    const script = scripted([
      { call: { name: 'show_connection', input: { toolkit: 'gmail', reason: 'See who is waiting on a reply from you.' } } },
      { text: "Connect Gmail and I'll find who's waiting on you." },
      { call: { name: 'search_gmail', input: { query: 'in:inbox is:unread newer_than:7d' } } },
      { text: "Dana needs your lease answer by Friday, and Sam wants to move Thursday's 1:1." },
    ]);
    const user = createScriptedUser([say('inbox is chaos, ppl waiting on me'), tap('connect_gmail'), leave()]);
    const trace = await simulate(persona('busy_founder'), { user, model: script.model });

    expect(user.seen[1].screen).toContain('[Card] Connect Gmail — See who is waiting on a reply from you. Read-only, and you can disconnect anytime. — buttons: Connect Gmail (connect_gmail) / Not now (not_now_gmail)');
    const connect = trace.steps[1];
    expect(connect).toMatchObject({ followUp: 'message', connected: ['gmail'] });
    expect(connect.turns[0]).toMatchObject({ kind: 'follow_up', trigger: 'followup:connection:gmail:sim-1:connected' });
    expect(connect.tools.map((tool) => tool.name)).toEqual(['search_gmail']);
    expect(trace.reads).toEqual([expect.objectContaining({ slug: 'GMAIL_FETCH_EMAILS', allowed: true })]);
    expect(valueMention(connect)).toBe('Dana');
    expect(user.seen[2].screen).toContain('(Gmail connected)');
    expect(scoreTrace(trace)).toMatchObject({ gmailConnected: true, firstValue: true, stayed: true });
    expect(simInvariants(trace).filter((check) => !check.passed)).toEqual([]);
  });

  it('does not count a read the assistant never talks about', async () => {
    const script = scripted([
      { call: { name: 'show_connection', input: { toolkit: 'gmail', reason: 'See who is waiting on you.' } } },
      { text: 'Connect Gmail below.' },
      { call: { name: 'search_gmail', input: { query: 'in:inbox' } } },
      { text: "You're connected. What should I look for first?" },
    ]);
    const trace = await simulate(persona('busy_founder'), { user: createScriptedUser([say('my inbox is a mess'), tap('connect_gmail'), leave()]), model: script.model });
    expect(scoreTrace(trace)).toMatchObject({ gmailConnected: true, firstValue: false });
  });

  it('approves a recurring task through the app endpoint and counts the person as activated', async () => {
    const script = scripted([
      { call: { name: 'propose_automation', input: { title: 'Morning action digest', instruction: 'List the emails in the inbox that need action, newest first.', cadence: 'weekdays', time: '07:30', toolkits: ['gmail'] } } },
      { text: 'Here is a preview. Approve it and it starts tomorrow morning.' },
    ]);
    const user = createScriptedUser([say('Can you send me a digest of what needs action every weekday at 7:30?'), tap('approve_task'), leave()]);
    const trace = await simulate(persona('executive_assistant'), { user, model: script.model });

    expect(user.seen[1].screen).toContain('[Card] Recurring task preview: "Morning action digest", Every weekday at 7:30 AM in your time zone — List the emails in the inbox that need action, newest first. — buttons: Approve (approve_task) / Not now (not_now_task)');
    expect(trace.steps[1].turns).toEqual([]);
    // Sunday noon UTC in New York: the first run is Monday 7:30 EDT.
    expect(trace.events).toContainEqual(expect.objectContaining({ type: 'automation', phase: 'approved', title: 'Morning action digest', schedule: 'every weekday at 7:30 AM', nextRunAt: '2026-09-28T11:30:00.000Z' }));
    expect(trace.finalProgress.automation).toMatchObject({ status: 'active' });
    expect(user.seen[2].screen).toContain('(Recurring task on: "Morning action digest", every weekday at 7:30 AM)');
    expect(scoreTrace(trace)).toMatchObject({ taskProposed: true, activated: true });
    expect(script.remaining()).toBe(0);
  });

  it('records the app events for each Not now without running an assistant turn', async () => {
    const script = scripted([
      { call: { name: 'offer_call', input: {} } },
      { call: { name: 'show_connection', input: { toolkit: 'gmail', reason: 'Draft replies from your real threads.' } } },
      { call: { name: 'propose_automation', input: { title: 'Reply drafts', instruction: 'Draft replies to the emails waiting on me.', cadence: 'daily', time: '09:00' } } },
      { text: 'A few ways I can help, whenever you like.' },
    ]);
    const user = createScriptedUser([say('What would you do with my email, exactly?'), tap('not_now_call'), tap('not_now_gmail'), tap('not_now_task'), leave('neutral')]);
    const trace = await simulate(persona('privacy_skeptic'), { user, model: script.model });

    expect(script.remaining()).toBe(0);
    expect(trace.steps.slice(1, 4).map((step) => [step.turns.length, step.error])).toEqual([[0, undefined], [0, undefined], [0, undefined]]);
    expect(trace.events).toContainEqual(expect.objectContaining({ id: 'call-offer:sim-0:declined', type: 'call', phase: 'declined' }));
    expect(trace.events).toContainEqual(expect.objectContaining({ id: expect.stringMatching(/^connection:gmail:declined:/), type: 'connection', phase: 'declined' }));
    expect(trace.events).toContainEqual(expect.objectContaining({ id: expect.stringMatching(/^automation:.+:declined$/), type: 'automation', phase: 'declined' }));
    expect(trace.finalProgress).toMatchObject({ call: 'declined', gmail: 'declined', automation: { status: 'declined' } });
    const screen = user.seen[4].screen;
    expect(screen).toContain('(Call declined)');
    expect(screen).toContain('(Skipped Gmail for now)');
    expect(screen).toContain('(Skipped "Reply drafts")');
    expect(screen).toContain('No buttons to tap right now.');
    expect(scoreTrace(trace)).toMatchObject({ callOffered: true, callHappened: false, taskProposed: true, activated: false, stayed: true });
  });

  it('records a tap on a button that is not on screen as a harness error and keeps going', async () => {
    const script = scripted([{ text: 'Hi. What should I call you?' }]);
    const trace = await simulate(persona('one_word'), { user: createScriptedUser([tap('approve_task'), say('hi'), leave('neutral')]), model: script.model });
    expect(trace.status).toBe('left');
    expect(trace.steps[0].error).toBe('tapped approve_task, which is not on screen');
    expect(trace.steps[1]).toMatchObject({ outputs: ['Hi. What should I call you?'] });
    expect(trace.steps[1].error).toBeUndefined();
  });

  it('counts leaving annoyed as not staying', async () => {
    const script = scripted([{ text: 'I can help with lots of things!' }]);
    const trace = await simulate(persona('burned_before'), { user: createScriptedUser([say('ok. prove it.'), leave('annoyed')]), model: script.model });
    expect(trace).toMatchObject({ status: 'left', leave: { feeling: 'annoyed' } });
    expect(scoreTrace(trace).stayed).toBe(false);
  });

  it('drops the line after the second exchange for a persona on patchy data, then follows up in text', async () => {
    const script = scripted([
      { call: { name: 'offer_call', input: {} } },
      { text: 'Nova it is. Tap Answer for a quick call.' },
      { text: 'Hi, Nova here, picking up from the chat. What should I call you?' },
      { text: "Nice to meet you, Lee. What's on your plate this week?" },
      { text: "Got it. Let's list the buyers." },
      { text: "Looks like the line dropped. You were saying you keep losing track of follow-ups after this week's showings. Want to keep going here?" },
    ]);
    const user = createScriptedUser([say('call yourself Nova, and yes a call works'), tap('answer_call'), speak("It's Lee"), speak('Follow-ups after the showings this week, I keep losing track of who'), leave()]);
    const trace = await simulate(persona('dropped_call'), { user, model: script.model });

    const dropped = trace.steps[3];
    expect(dropped.delivered).toBeUndefined();
    expect(dropped).toMatchObject({ callEnded: 'connection_lost', followUp: 'message' });
    expect(dropped.outputs).toEqual(["Got it. Let's list the buyers.", expect.stringMatching(/line dropped/)]);
    expect(trace.events).toContainEqual(expect.objectContaining({ id: 'call:live_sim_1:dropped', phase: 'dropped', reason: 'connection_lost' }));
    expect(script.prompts[5]).toContain('The line dropped, so you may offer to call back');
    expect(user.seen[4].screen).toContain('· Call dropped]');
    expect(scoreTrace(trace)).toMatchObject({ callHappened: true, stayed: true });
  });

  it('drops only the first call, so a callback the app offers is measured as a call', async () => {
    const script = scripted([
      { call: { name: 'offer_call', input: {} } },
      { text: 'Tap Answer.' },
      { text: 'Hi.' },
      { text: 'Go on.' },
      { text: 'Mhm.' },
      { call: { name: 'offer_call', input: {} } },
      { text: 'The line dropped. Tap Answer to pick it back up.' },
      { text: 'Back again. You were saying?' },
      { text: 'Sure.' },
      { text: 'Okay.' },
      { text: '<silent>' },
    ]);
    const user = createScriptedUser([say('call?'), tap('answer_call'), speak('one'), speak('two'), tap('answer_call'), speak('three'), speak('four'), { type: 'hang_up' }, leave()]);
    const trace = await simulate(persona('dropped_call'), { user, model: script.model });

    expect(trace.steps[3]).toMatchObject({ callEnded: 'connection_lost', followUp: 'message' });
    expect(user.seen[4].screen).toContain('[Card] Persona is ready to call');
    expect(script.prompts[7]).toContain("Mention you're glad to be back after the line dropped.");
    expect(trace.steps[6].callEnded).toBeUndefined();
    expect(trace.steps[7]).toMatchObject({ callEnded: 'user_hangup', followUp: 'silent' });
    expect(script.remaining()).toBe(0);
  });

  it('ends a long call naturally after six utterances and records a silent follow-up', async () => {
    const script = scripted([
      { call: { name: 'offer_call', input: {} } },
      { text: 'Tap Answer.' },
      { text: 'Hey, picking up from the chat.' },
      ...Array.from({ length: 6 }, () => ({ text: 'Mm, go on.' })),
      { text: '<silent>' },
    ]);
    const user = createScriptedUser([say('call me'), tap('answer_call'), ...Array.from({ length: 6 }, (_, index) => speak(`point ${index + 1}.`)), leave()]);
    const trace = await simulate(persona('busy_founder'), { user, model: script.model });

    expect(trace.steps[7]).toMatchObject({ callEnded: 'remote_hangup', followUp: 'silent', outputs: ['Mm, go on.'] });
    expect(trace.events).toContainEqual(expect.objectContaining({ type: 'decision', trigger: 'followup:call:live_sim_1', outcome: 'silent' }));
    expect(trace.steps[8]).toMatchObject({ onCall: false, action: { type: 'leave' } });
    expect(script.remaining()).toBe(0);
  });

  it('lets the person connect Gmail mid-call: the live model is told and the text follow-up is recorded as handled', async () => {
    const script = scripted([
      { call: { name: 'offer_call', input: {} } },
      { text: 'Tap Answer and we can talk it through.' },
      { text: "Hi, I'm picking up from the chat. What should I call you?" },
      { call: { name: 'show_connection', input: { toolkit: 'gmail', reason: 'So I can find what needs action in the inbox.' } } },
      { text: "I've put a Connect Gmail button on your screen." },
      { text: "Gmail's connected. Want me to take a look?" },
      { call: { name: 'search_gmail', input: { query: 'in:inbox is:unread' } } },
      { text: 'Dana needs a lease answer by Friday, and Sam wants to move the Thursday 1:1.' },
      { text: '<silent>' },
    ]);
    const user = createScriptedUser([
      say('I run my boss inbox and need a daily digest'), tap('answer_call'), speak("I manage my boss's inbox, and I need to know what needs action."),
      tap('connect_gmail'), speak('yes please'), { type: 'hang_up' }, leave(),
    ]);
    const trace = await simulate(persona('executive_assistant'), { user, model: script.model });

    expect(user.seen[3].screen).toContain('Buttons you can still tap on screen: connect_gmail, not_now_gmail');
    const connected = trace.steps[3];
    expect(connected).toMatchObject({ onCall: true, outputs: ["Gmail's connected. Want me to take a look?"] });
    expect(connected.followUp).toBeUndefined();
    expect(connected.turns[0]).toMatchObject({ kind: 'voice_notice', channel: 'voice' });
    expect(trace.events).toContainEqual(expect.objectContaining({ type: 'decision', trigger: 'followup:connection:gmail:sim-3:connected', outcome: 'silent' }));
    expect(trace.steps[4].tools.map((tool) => tool.name)).toEqual(['search_gmail']);
    expect(trace.steps[5]).toMatchObject({ callEnded: 'user_hangup', followUp: 'silent' });
    expect(scoreTrace(trace)).toMatchObject({ gmailConnected: true, firstValue: true, callHappened: true });
    expect(script.remaining()).toBe(0);
  });

  it('ends the conversation cleanly with status error when the model fails or hangs', async () => {
    const failed = await simulate(persona('explorer'), { user: createScriptedUser([say('what is this?')]), model: scripted([{ fail: 'provider exploded' }]).model });
    expect(failed).toMatchObject({ status: 'error', error: 'provider exploded' });
    expect(failed.steps[0].incomplete).toBe(true);
    expect(scoreTrace(failed).stayed).toBe(false);
    expect(simInvariants(failed).filter((check) => !check.passed)).toEqual([]);

    const hung = await simulate(persona('explorer'), { user: createScriptedUser([say('what is this?')]), model: scripted([{ hang: true }]).model, turnTimeoutMs: 50 });
    expect(hung.status).toBe('error');
    expect(hung.error).toMatch(/reply turn timed out/);

    const userFailed = await simulate(persona('explorer'), { user: { next: async () => { throw new Error('Anthropic API HTTP 401'); } }, model: scripted([]).model });
    expect(userFailed).toMatchObject({ status: 'error', error: 'Anthropic API HTTP 401', steps: [] });
  });

  it('stops at the action budget, ending a live call and following up', async () => {
    const script = scripted([
      { call: { name: 'offer_call', input: {} } },
      { text: 'Tap Answer.' },
      { text: 'Hi there.' },
      { text: 'We got cut short; want to keep going here?' },
    ]);
    const trace = await simulate(persona('busy_founder'), { user: createScriptedUser([say('call?'), tap('answer_call'), speak('hello')]), model: script.model, maxActions: 2 });
    expect(trace.status).toBe('max_actions');
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[1]).toMatchObject({ callEnded: 'remote_hangup', followUp: 'message' });
  });
});

describe('harness helpers', () => {
  it('cuts about 60% of a sentence at a word boundary, never ending on punctuation', () => {
    expect(cutMidSentence('Honestly the investor updates, every month I have to rewrite everything.')).toBe('Honestly the investor updates, every month');
    expect(cutMidSentence('Mostly the board meeting, and')).toBe('Mostly the board');
    expect(cutMidSentence('Yes.')).toBe('Ye');
    expect(cutMidSentence('Two words')).toBe('Two');
  });

  it('splits long speech into transcript fragments of at most 500 characters that join back into words', () => {
    const text = Array.from({ length: 200 }, (_, index) => `word${index}`).join(' ');
    const chunks = fragmentChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500 && chunk.startsWith(' '))).toBe(true);
    expect(chunks.join('').trim()).toBe(text);
  });

  it('times out slow work without leaving an unhandled rejection behind', async () => {
    const late = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late')), 30));
    await expect(withTimeout(late, 5, 'Slow work')).rejects.toThrow('Slow work timed out');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(withTimeout(Promise.resolve('fast'), 50, 'Fast work')).resolves.toBe('fast');
  });
});
