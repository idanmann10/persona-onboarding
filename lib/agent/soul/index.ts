import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentName } from '../../domain/events';

export type { AgentName };

/**
 * Each agent's soul: who it is and how it sounds, in plain Markdown so it can be edited without code.
 * A prompt is soul + product and policy rules + state, in that order, and says the rules win.
 */
export const AGENTS: readonly AgentName[] = ['assistant', 'coach', 'memory'];
export const SOUL_VERSION = 'soul/v1';

const cache = new Map<AgentName, string>();

/** Read from the project root, so Next (with outputFileTracingIncludes), Bun scripts and evals all agree. */
export function soul(agent: AgentName): string {
  let text = cache.get(agent);
  if (text === undefined) {
    text = readFileSync(join(process.cwd(), 'lib', 'agent', 'soul', `${agent}.md`), 'utf8').trim();
    // Cached in production; in development an edit to a soul shows up on the next turn.
    if (process.env.NODE_ENV === 'production') cache.set(agent, text);
  }
  return text;
}

/** One `## heading` section of a soul, without the heading (for the short GPT-Live prompt). */
export function soulSection(agent: AgentName, heading: string): string {
  const match = new RegExp(`^## ${heading.replace(/[()]/g, '\\$&')}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(soul(agent));
  return match?.[1].trim() ?? '';
}

/**
 * The soul plus what this agent has learned about being with this particular user. The notes sit inside
 * the soul, before the rules, so a note can shape style but never outrank policy.
 */
export function soulWithNotes(agent: AgentName, notes: string[]): string {
  if (!notes.length) return soul(agent);
  return `${soul(agent)}

## what you've learned about being with this person

Your own notes from earlier conversations with them. They shape style only; the rules that follow still win.
${notes.map((note) => `- ${note}`).join('\n')}`;
}
