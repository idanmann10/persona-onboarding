import { appendFile, mkdir } from 'node:fs/promises';
import brief from './cases/brief.json';
import base from './cases/base.json';
import { parseCorpus } from './cases/schema';
import { parseScenarios, replayScenario, type Scenario } from './app/replay';
import { checkExpectations, checkInvariants } from './app/invariants';

/**
 * App-level scenario replay: each scenario runs through the real turn builder, tools, gates and
 * follow-up triggers with an in-memory store and Gmail/Calendar fixtures; only the model is live.
 * Hard invariants are checked automatically; the rubric is left for human scoring (scored: false).
 *
 *   bun run eval:app --id brief_hangup_mid_sentence
 *   bun run eval:app --all [--base] [--repeats 3]
 */
const args = process.argv.slice(2);
const model = process.env.OPENAI_TEXT_MODEL;
if (!process.env.OPENAI_API_KEY || !model) throw new Error('OPENAI_API_KEY and OPENAI_TEXT_MODEL are required');
const repeatIndex = args.indexOf('--repeats');
const repeats = repeatIndex >= 0 ? Number(args[repeatIndex + 1]) : 1;
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('--repeats must be 1-5');

const scenarios: Scenario[] = [
  ...parseScenarios(brief),
  ...(args.includes('--base') ? parseCorpus(base).map((item): Scenario => ({
    id: item.id, title: item.id, critical: item.critical, setup: { connected: [] },
    steps: item.turns.filter((turn) => turn.actor === 'user').map((turn) => ({ user: turn.content })),
    expect: { tools: [], facts: {}, mentions: [], notMentions: [], notTools: [] }, rubric: item.expected,
  })) : []),
];
const idIndex = args.indexOf('--id');
const selected = args.includes('--all') ? scenarios : scenarios.filter((scenario) => scenario.id === args[idIndex + 1]);
if (!selected.length) throw new Error('Select a scenario with --id <id>, or use --all (add --base for the 48 seed cases)');

await mkdir(new URL('./results/', import.meta.url), { recursive: true });
const runId = `app-${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID().slice(0, 8)}`;
const output = new URL(`./results/${runId}.jsonl`, import.meta.url);
let hardFailures = 0;
for (const scenario of selected) {
  for (let attempt = 1; attempt <= repeats; attempt++) {
    const started = Date.now();
    try {
      const trace = await replayScenario(scenario, { textModel: model, reasoningEffort: process.env.OPENAI_REASONING_EFFORT });
      const invariants = checkInvariants(trace);
      const expectations = checkExpectations(scenario, trace);
      const failed = invariants.filter((result) => !result.passed);
      hardFailures += failed.length;
      await appendFile(output, JSON.stringify({
        runId, scenarioId: scenario.id, attempt, model, promptVersion: trace.promptVersion, fixtureVersion: trace.fixtureVersion,
        critical: scenario.critical, rubric: scenario.rubric, invariants, expectations, steps: trace.steps, reads: trace.reads,
        finalProgress: trace.finalProgress, durationMs: Date.now() - started, scored: false,
      }) + '\n');
      const met = expectations.filter((result) => result.passed).length;
      process.stdout.write(`${failed.length ? 'FAIL' : 'ok  '} ${scenario.id} #${attempt}  invariants ${invariants.length - failed.length}/${invariants.length}  expectations ${met}/${expectations.length}${failed.length ? `  -> ${failed.map((result) => result.id).join(', ')}` : ''}\n`);
    } catch (error) {
      hardFailures += 1;
      await appendFile(output, JSON.stringify({ runId, scenarioId: scenario.id, attempt, model, status: 'error', error: error instanceof Error ? error.message.slice(0, 300) : 'Unknown error', durationMs: Date.now() - started }) + '\n');
      process.stdout.write(`ERR  ${scenario.id} #${attempt}  ${error instanceof Error ? error.message.slice(0, 120) : error}\n`);
    }
  }
}
process.stdout.write(`\nWrote ${output.pathname}. Hard invariant failures: ${hardFailures}. Rubric scoring is manual (see evals/rubric.md).\n`);
if (hardFailures) process.exitCode = 1;
