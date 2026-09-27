import { z } from 'zod';

export const scenarioGroups = [
  'entry_intent', 'pace_trust', 'channel_switch', 'identity',
  'connection', 'tool_action', 'correction_memory', 'automation_abuse',
] as const;

const turnSchema = z.object({
  actor: z.enum(['user', 'agent', 'system']),
  channel: z.enum(['text', 'voice', 'event']),
  content: z.string().min(1),
});

const caseSchema = z.object({
  id: z.string().min(1),
  group: z.enum(scenarioGroups),
  turns: z.array(turnSchema).min(1),
  expected: z.array(z.string().min(1)).min(1),
  critical: z.boolean(),
});

export type ScenarioCase = z.infer<typeof caseSchema>;

export function parseCorpus(input: unknown): ScenarioCase[] {
  const cases = z.array(caseSchema).parse(input);
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate scenario ID: ${item.id}`);
    ids.add(item.id);
  }
  return cases;
}
