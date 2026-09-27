import { z } from 'zod';
import raw from './personas.json';

/**
 * A simulated new user. The policies (gmail, calendar, call, recurring, patience) are what the
 * simulated user follows; the harness itself enforces only how a call ends (a mid-sentence hang-up
 * or a dropped line), because a real person cannot choose that.
 */
export const personaSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  /** Who they are, in one or two sentences. */
  summary: z.string().min(20).max(400),
  /** What they came for. */
  goal: z.string().min(10).max(400),
  /** How they write. */
  style: z.string().min(10).max(400),
  behaviors: z.array(z.string().min(3).max(200)).min(2).max(8),
  /** Unhelpful assistant replies in a row before they leave. */
  patience: z.number().int().min(2).max(6),
  gmail: z.enum(['connects', 'connects_if_convinced', 'never']),
  calendar: z.enum(['connects', 'never']),
  call: z.enum(['accepts', 'declines', 'hangs_up_mid_sentence', 'drops']),
  recurring: z.enum(['open', 'skeptical', 'never']),
  /** BCP 47 language code the person writes and speaks in. */
  language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).default('en'),
}).strict();

export type Persona = z.infer<typeof personaSchema>;

export function parsePersonas(input: unknown): Persona[] {
  const personas = z.array(personaSchema).min(1).parse(input);
  const ids = new Set<string>();
  for (const persona of personas) {
    if (ids.has(persona.id)) throw new Error(`Duplicate persona ID: ${persona.id}`);
    ids.add(persona.id);
  }
  return personas;
}

export function loadPersonas(): Persona[] {
  return parsePersonas(raw);
}
