import type { AgentName } from './events';
import type { SessionProjection } from './project';

/**
 * The code-side limits on what agents may write about a user: soul notes, memory notes and labels.
 * A model proposes; these checks decide. Nothing here can grant access: labels and notes are shown to
 * the models as data about the user, below the rules, and no gate in the app reads them.
 */
export const SOUL_NOTE_LIMITS = { chars: 140, shown: 8, perSession: 20 } as const;
export const NOTE_LIMITS = { chars: 160, shown: 20 } as const;
export const LABEL_LIMITS = { chars: 40, active: 12 } as const;
export const LOOP_LIMITS = { chars: 160, open: 6 } as const;

const UNSAFE = /[\u0000-\u001f\u007f]|https?:\/\/|www\./i;
/** A line that tries to change the rules rather than describe the person ("ignore your instructions"). */
const INSTRUCTION_LIKE = /\b(ignore|disregard|override|bypass|forget|drop)\b.{0,40}\b(rules?|instructions?|prompts?|polic(y|ies)|guardrails?|limits?|restrictions?)\b|\b(system prompt|developer (message|mode)|jailbreak|admin mode|no (rules|restrictions|limits)|you (are|'re) (now )?allowed|always (share|send|forward|reveal))\b/i;
/** Labels never describe sensitive categories, whatever the evidence. */
const SENSITIVE = /\b(health|ill(ness)?|sick|disease|diagnos\w*|pregnan\w*|religio\w*|christian|muslim|jewish|hindu|buddhist|atheist|politic\w*|democrat|republican|conservative|liberal|gay|lesbian|bisexual|trans(gender)?|queer|sexual\w*|ethnic\w*|race|racial|disab\w*|mental|depress\w*|anxi\w*|adhd|autis\w*|debt|broke|bankrupt\w*|divorc\w*)\b/i;

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** One clean line, or undefined when it's empty, too long, carries a link or reads like an instruction. */
export function cleanLine(text: string, max: number): string | undefined {
  const line = text.replace(/\s+/g, ' ').trim().replace(/^[-*•]\s*/, '');
  if (line.length < 3 || line.length > max || UNSAFE.test(line) || INSTRUCTION_LIKE.test(line)) return undefined;
  return line;
}

export type Accepted = { ok: true; text: string } | { ok: false; reason: string };

/** A new line for an agent's soul, checked against the caps and what it already knows. */
export function acceptSoulNote(state: SessionProjection, agent: AgentName, text: string): Accepted {
  const line = cleanLine(text, SOUL_NOTE_LIMITS.chars);
  if (!line) return { ok: false, reason: `One plain line about how to be with them, up to ${SOUL_NOTE_LIMITS.chars} characters, no links, and never about rules or instructions.` };
  const notes = state.memory.soulNotes[agent] ?? [];
  if (notes.length >= SOUL_NOTE_LIMITS.perSession) return { ok: false, reason: 'You already have plenty of notes for this person.' };
  if (notes.some((note) => normalize(note.text) === normalize(line))) return { ok: false, reason: 'Already noted.' };
  return { ok: true, text: line };
}

/** The notes an agent's prompt shows, newest kept. */
export function soulNotes(state: SessionProjection, agent: AgentName): string[] {
  return (state.memory.soulNotes[agent] ?? []).slice(-SOUL_NOTE_LIMITS.shown).map((note) => note.text);
}

export function acceptNote(state: SessionProjection, text: string): Accepted {
  const line = cleanLine(text, NOTE_LIMITS.chars);
  if (!line) return { ok: false, reason: 'unsafe or too long' };
  if (state.memory.notes.some((note) => normalize(note.text) === normalize(line))) return { ok: false, reason: 'duplicate' };
  return { ok: true, text: line };
}

export function acceptLabel(state: SessionProjection, label: string, adding: boolean): Accepted {
  const line = cleanLine(label, LABEL_LIMITS.chars)?.toLocaleLowerCase();
  if (!line || SENSITIVE.test(line)) return { ok: false, reason: 'not a label we keep' };
  const active = Object.keys(state.memory.labels);
  if (adding && !active.includes(line) && active.length >= LABEL_LIMITS.active) return { ok: false, reason: 'too many labels' };
  return { ok: true, text: line };
}

/** A short stable id for a loop, so the memory can close it later by id. */
export function loopId(text: string, at: string): string {
  let hash = 0;
  for (const char of `${at}:${text}`) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return `L${(hash >>> 0).toString(36).slice(0, 6)}`;
}
