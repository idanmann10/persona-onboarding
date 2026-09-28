import type { ModelMessage } from 'ai';
import type { SessionProjection } from '../domain/project';

/** The conversation as lines, typed or spoken, and the window of it a prompt can hold. */

export type Line = { speaker: 'user' | 'assistant'; text: string; voice: boolean };

const MESSAGE_LIMIT = 40;
const CHARACTER_LIMIT = 24_000;

/** Every line of the conversation in order, typed or spoken. */
export function conversationLines(state: SessionProjection): Line[] {
  const lines: Line[] = [];
  for (const item of state.timeline) {
    if (item.kind === 'message' && item.text.trim()) lines.push({ speaker: item.speaker, text: item.text, voice: item.channel === 'voice' });
    if (item.kind === 'call') for (const utterance of item.call.utterances) lines.push({ speaker: utterance.speaker, text: utterance.text, voice: true });
  }
  return lines;
}

/** How many of the oldest lines fall outside the prompt window; the memory summarizes those. */
export function windowStart(lines: Line[]): number {
  let characters = 0;
  let kept = 0;
  for (let index = lines.length - 1; index >= 0 && kept < MESSAGE_LIMIT; index--) {
    const length = Math.min(lines[index].text.length, 4_000);
    if (characters + length > CHARACTER_LIMIT && kept) return index + 1;
    characters += length;
    kept++;
  }
  return lines.length - kept;
}

/** The conversation as the model sees it: text turns plus call turns marked `(on the call)`, newest kept. */
export function modelMessages(state: SessionProjection): ModelMessage[] {
  const lines = conversationLines(state);
  return lines.slice(windowStart(lines)).map((line) => ({ role: line.speaker, content: `${line.voice ? '(on the call) ' : ''}${line.text.slice(0, 4_000)}` }));
}

/** The assistant line the user's latest words answer (its question before their "yes"), if any. */
export function answeredQuestion(state: SessionProjection): string | undefined {
  const lines = conversationLines(state);
  const lastUser = lines.map((line) => line.speaker).lastIndexOf('user');
  for (let index = lastUser - 1; index >= 0; index--) if (lines[index].speaker === 'assistant') return lines[index].text;
  return undefined;
}

/** The user's own recent words, typed or spoken, newest last. */
export function userWords(state: SessionProjection, limit = 6): string[] {
  return conversationLines(state).filter((line) => line.speaker === 'user').map((line) => line.text).slice(-limit);
}

/** The last few lines as short plain text, for a subagent's small input. */
export function recentLines(lines: Line[], count = 8, max = 300): string[] {
  return lines.slice(-count).map((line) => `${line.speaker}${line.voice ? ' (call)' : ''}: ${line.text.replace(/\s+/g, ' ').slice(0, max)}`);
}
