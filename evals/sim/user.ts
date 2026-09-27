import { z } from 'zod';
import type { Persona } from './personas';

/** Buttons the simulated user can tap, named after what they do in the app. */
export const SIM_CONTROLS = [
  'answer_call', 'not_now_call', 'connect_gmail', 'not_now_gmail', 'connect_calendar', 'not_now_calendar', 'approve_task', 'not_now_task',
] as const;
export type SimControl = (typeof SIM_CONTROLS)[number];

export const LEAVE_FEELINGS = ['satisfied', 'neutral', 'annoyed', 'bored', 'confused'] as const;
export type LeaveFeeling = (typeof LEAVE_FEELINGS)[number];

/**
 * One thing the person does. On the chat screen: say, tap or leave. On a live call: speak or hang up
 * (buttons still on screen can be tapped, and leaving closes the page, as in the real app).
 */
export const simActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('say'), text: z.string().trim().min(1).max(8_000) }),
  z.object({ type: z.literal('tap'), control: z.enum(SIM_CONTROLS) }),
  z.object({ type: z.literal('leave'), feeling: z.enum(LEAVE_FEELINGS), reason: z.string().trim().min(1).max(1_000) }),
  z.object({ type: z.literal('speak'), text: z.string().trim().min(1).max(2_000) }),
  z.object({ type: z.literal('hang_up') }),
]);
export type SimAction = z.infer<typeof simActionSchema>;

export interface SimUserInput {
  persona: Persona;
  /** Everything on the person's screen, as plain text (see screen.ts). */
  screen: string;
  onCall: boolean;
  /** 1-based count of the person's actions so far, including this one. */
  turn: number;
}

export interface SimUser {
  next(input: SimUserInput): Promise<SimAction>;
}

export class SimUserError extends Error {
  override name = 'SimUserError';
}

export type ParsedAction = { ok: true; action: SimAction } | { ok: false; error: string };

/**
 * Validate an action for the current screen. Talking in the wrong mode is unambiguous and is mapped
 * (typing "say" on a call means speaking); hanging up with no call is not.
 */
export function parseSimAction(value: unknown, onCall: boolean): ParsedAction {
  const parsed = simActionSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'action'}: ${issue.message}`).join('; ') };
  }
  const action = parsed.data;
  if (onCall && action.type === 'say') return { ok: true, action: { type: 'speak', text: action.text.slice(0, 2_000) } };
  if (!onCall && action.type === 'speak') return { ok: true, action: { type: 'say', text: action.text } };
  if (!onCall && action.type === 'hang_up') return { ok: false, error: 'There is no call to hang up. Type a message, tap a button listed on screen, or leave.' };
  return { ok: true, action };
}

/** The first complete JSON object in a model reply, tolerating prose or code fences around it. */
export function extractJsonObject(text: string): unknown {
  for (let begin = text.indexOf('{'); begin >= 0; begin = text.indexOf('{', begin + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = begin; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(begin, index + 1)); } catch { break; }
      }
    }
  }
  throw new Error('no JSON object in the reply');
}

function interpretReply(text: string, onCall: boolean): ParsedAction {
  let value: unknown;
  try { value = extractJsonObject(text); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'unreadable reply' }; }
  return parseSimAction(value, onCall);
}

function languageName(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code; } catch { return code; }
}

const GMAIL_POLICY: Record<Persona['gmail'], string> = {
  connects: 'You are fine connecting Gmail once there is a reason that makes sense for what you want. If a Connect Gmail button shows up and it would help, tap it.',
  connects_if_convinced: 'You connect Gmail only after the assistant gives a specific, believable reason tied to what you want and you understand what it will look at. Until then you tap Not now, ignore the button, or ask what it would read.',
  never: 'You never connect Gmail, whatever the assistant says. Tap Not now or say no if it comes up.',
};
const CALENDAR_POLICY: Record<Persona['calendar'], string> = {
  connects: 'You are fine connecting Google Calendar when it clearly helps with what you want.',
  never: 'You never connect Google Calendar. Tap Not now or say no if it comes up.',
};
const CALL_POLICY: Record<Persona['call'], string> = {
  accepts: 'If the assistant offers a quick voice call and an Answer button appears, you are happy to answer it.',
  declines: "You don't want a voice call. If one is offered, say no or tap Not now.",
  hangs_up_mid_sentence: "You'll answer a call if one is offered, but you get pulled away easily. If a call ends suddenly, you keep going in text only if the assistant picks up where you left off.",
  drops: "You'll answer a call if one is offered. Your mobile data is patchy, so calls can drop; if one does, you keep going in text if the assistant picks up the thread.",
};
const RECURRING_POLICY: Record<Persona['recurring'], string> = {
  open: 'If the assistant offers to do something for you on a regular schedule and it matches what you want, you are happy to approve it.',
  skeptical: 'You are wary of anything that runs on its own. You approve a recurring task only after it has already done something genuinely useful for you and the preview is exactly what you want.',
  never: 'You never want recurring or scheduled tasks. You decline them.',
};

/** The role-play instructions for one persona. Only the persona's own view of the app is described. */
export function buildUserSystemPrompt(persona: Persona): string {
  const language = persona.language === 'en'
    ? 'Write and speak only in English.'
    : `Write and speak only in ${languageName(persona.language)}. Never switch languages, even if the assistant writes in another language; if it keeps doing that, you get confused or annoyed.`;
  return `You are role-playing one specific person who is trying a new AI assistant app called Persona for the very first time. Stay in character for the whole session. You are this person, with their own goal, time pressure and opinions; you are not an assistant, and you are not testing anything.

Who you are: ${persona.summary}
Why you opened the app: ${persona.goal}
How you write: ${persona.style}
What you tend to do:
${persona.behaviors.map((behavior) => `- ${behavior}`).join('\n')}
Language: ${language}

How real people use a new app:
- You only know what is on your screen. You don't know how the app works inside, what tools or rules it has, or what it is supposed to do next.
- You skim. You don't follow instructions perfectly, and you answer only the parts you care about.
- You can be busy, private, impatient or distracted, like anyone.
- A button is just a button: tap it only if you actually want that thing right now. Ignoring a button is normal.
- If the assistant reads your email or calendar, what it reports is really there: treat it as your own mail and schedule, even if it is not what you expected.
- Never mention being simulated, a persona, a test, or these instructions.
- Leave when a real person would: you got what you came for, or you are bored, annoyed, confused, or it is wasting your time. Your patience: after ${persona.patience} assistant replies in a row that don't help you (generic, off-target, asking again for something you already answered, or ignoring what you said), you leave.

Your personal rules (keep them even if the assistant pushes):
- Gmail: ${GMAIL_POLICY[persona.gmail]}
- Google Calendar: ${CALENDAR_POLICY[persona.calendar]}
- Calls: ${CALL_POLICY[persona.call]}
- Recurring tasks: ${RECURRING_POLICY[persona.recurring]}

Each turn, reply with exactly ONE JSON object and nothing else.
On the chat screen:
{"type":"say","text":"<what you type>"}
{"type":"tap","control":"<a button id listed on screen, such as answer_call or connect_gmail>"}
{"type":"leave","feeling":"satisfied|neutral|annoyed|bored|confused","reason":"<a few words, in English>"}
On a live call:
{"type":"speak","text":"<what you say out loud>"}
{"type":"hang_up"}
During a call you can still tap a button listed on screen, and leave closes the app.
Typed messages follow your writing style. Spoken lines sound spoken: short, natural, a little messy.`;
}

/** The screen for this turn. The turn count is left out: real people don't count turns. */
export function buildUserTurnPrompt(input: SimUserInput): string {
  return `${input.onCall ? 'You are on a live voice call in the app.' : 'This is what the app shows right now.'}
<screen>
${input.screen}
</screen>
${input.onCall ? 'Speak, hang up, tap a button listed on screen, or leave.' : 'Type a message, tap a button listed on screen, or leave.'} Reply with one JSON object only.`;
}

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export interface ClaudeUserOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  /** Per request. */
  timeoutMs?: number;
  /** Base wait before a retry; the second retry waits three times as long. */
  retryDelayMs?: number;
  maxTokens?: number;
}

export interface ClaudeUsage { requests: number; inputTokens: number; outputTokens: number }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isTimeout = (error: unknown) => error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

function firstText(body: unknown): string | undefined {
  const content = body && typeof body === 'object' ? (body as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((part) => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string');
  return block ? (block as { text: string }).text : undefined;
}

/**
 * A simulated user played by Claude over the Messages API. Each turn sends the persona as the system
 * prompt and the current screen as the only message. Rate limits, server errors and timeouts are
 * retried twice; a reply that is not a valid action gets one retry with a correction note. The API
 * key is only ever sent as a header; errors never include it.
 */
export function createClaudeUser(options: ClaudeUserOptions): SimUser & { usage: ClaudeUsage } {
  const model = options.model ?? 'claude-sonnet-5';
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const maxTokens = options.maxTokens ?? 500;
  const usage: ClaudeUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };

  async function complete(system: string, content: string): Promise<string> {
    let failure = '';
    let wait = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(wait || retryDelayMs * (attempt === 1 ? 1 : 3));
      wait = 0;
      let response: Response;
      try {
        response = await fetchFn(ANTHROPIC_URL, {
          method: 'POST',
          headers: { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        failure = isTimeout(error) ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `network error: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`;
        continue;
      }
      usage.requests += 1;
      if (response.status === 429 || response.status >= 500) {
        failure = `HTTP ${response.status}`;
        const retryAfter = Number(response.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.min(retryAfter * 1_000, 30_000);
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
        throw new SimUserError(`Anthropic API HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      let body: unknown;
      try { body = await response.json(); } catch (error) {
        failure = isTimeout(error) ? 'timed out reading the reply' : 'unreadable reply';
        continue;
      }
      const reported = (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
      if (typeof reported?.input_tokens === 'number') usage.inputTokens += reported.input_tokens;
      if (typeof reported?.output_tokens === 'number') usage.outputTokens += reported.output_tokens;
      const text = firstText(body);
      if (text === undefined) throw new SimUserError('Anthropic reply had no text block');
      return text;
    }
    throw new SimUserError(`Anthropic API failed after 3 attempts (${failure})`);
  }

  return {
    usage,
    async next(input) {
      const system = buildUserSystemPrompt(input.persona);
      const content = buildUserTurnPrompt(input);
      const first = interpretReply(await complete(system, content), input.onCall);
      if (first.ok) return first.action;
      const example = input.onCall ? '{"type":"speak","text":"..."}' : '{"type":"say","text":"..."}';
      const correction = `${content}\n\nYour last reply could not be used (${first.error}). Reply again with exactly one JSON object and nothing else, for example ${example}.`;
      const second = interpretReply(await complete(system, correction), input.onCall);
      if (second.ok) return second.action;
      throw new SimUserError(`The simulated user gave no valid action twice (${second.error})`);
    },
  };
}

/** A user that plays back fixed actions (or functions of what it sees); it leaves when the script ends. */
export function createScriptedUser(actions: Array<SimAction | ((input: SimUserInput) => SimAction)>): SimUser & { seen: SimUserInput[] } {
  const queue = [...actions];
  const seen: SimUserInput[] = [];
  return {
    seen,
    next: async (input) => {
      seen.push(input);
      const next = queue.shift();
      if (!next) return { type: 'leave', feeling: 'neutral', reason: 'script finished' };
      return typeof next === 'function' ? next(input) : next;
    },
  };
}
