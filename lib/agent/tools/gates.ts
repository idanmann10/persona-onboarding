import type { Toolkit } from '../../domain/events';
import type { ToolContext } from './types';

/** Server checks shared by several tools. */

export const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();

/** True when the value appears in the user's own words as a whole-word phrase. */
export function saidByUser(value: string, words: string[]): boolean {
  const needle = normalize(value);
  if (!needle) return false;
  return words.some((text) => ` ${normalize(text)} `.includes(` ${needle} `));
}

export const CALL_WORDS = /\b(call|calling|talk|phone|voice|ring|speak)\b/i;
export const TOOLKIT_WORDS: Record<Toolkit, RegExp> = {
  gmail: /\b(gmail|e-?mails?|inbox|mail)\b/i,
  calendar: /\b(calendar|schedule|meetings?|agenda)\b/i,
};
export const TOOLKIT_NAMES: Record<Toolkit, string> = { gmail: 'Gmail', calendar: 'Google Calendar' };

/** Links, domains and control characters never go into a saved name, look or personality. */
export const UNSAFE = /[\u0000-\u001f\u007f]|https?:\/\/|www\.|\b[\w-]+\.(?:com|net|org|io|ai|co|app|dev|me|ly)\b/i;

export const timestamp = (ctx: ToolContext) => (ctx.now?.() ?? new Date()).toISOString();

/** A short hash for event ids that must differ per value within one turn. */
export function shortHash(text: string): string {
  let hash = 0;
  for (const char of text) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(36);
}
