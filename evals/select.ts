import { parseCorpus, type ScenarioCase } from './cases/schema';

export function selectScenarios(input: unknown, args: string[]): ScenarioCase[] {
  const cases = parseCorpus(input);
  if (args.includes('--all')) return cases;
  const idIndex = args.indexOf('--id');
  if (idIndex < 0 || !args[idIndex + 1]) throw new Error('Select one scenario with --id <case> or use --all');
  const selected = cases.find((item) => item.id === args[idIndex + 1]);
  if (!selected) throw new Error(`Unknown scenario ID: ${args[idIndex + 1]}`);
  return [selected];
}
