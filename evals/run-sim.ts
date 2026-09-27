import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadPersonas, type Persona } from './sim/personas';
import { simulate } from './sim/run';
import { createClaudeUser } from './sim/user';
import { scoreTrace, simInvariants } from './sim/score';
import { judgeConversation } from './sim/judge';
import { personaLine, summaryLines, type SimRow } from './sim/summary';

/**
 * Simulated users: an LLM plays each persona as a new user of the real app turn logic (the replay's
 * in-memory store and Gmail/Calendar fixtures, the real turn builder, tools, gates, follow-ups and
 * button endpoints), and we measure how many stay and activate. Jev judges each conversation when
 * TYPESAFE_API_KEY is set.
 *
 *   bun run eval:sim --all [--repeats 1-3] [--concurrency 4] [--max-actions 16] [--user-model claude-sonnet-5]
 *   bun run eval:sim --id busy_founder[,task_first]
 *
 * Needs OPENAI_API_KEY and OPENAI_TEXT_MODEL (the app) and ANTHROPIC_API_KEY (the simulated users);
 * TYPESAFE_API_KEY is optional, SIM_USER_MODEL overrides the simulated users' model. A conversation
 * that failed is not judged, so the judge's means cover whole conversations only.
 */
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const integer = (name: string, fallback: number, min: number, max: number) => {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
};

const model = process.env.OPENAI_TEXT_MODEL;
if (!process.env.OPENAI_API_KEY || !model) throw new Error('OPENAI_API_KEY and OPENAI_TEXT_MODEL are required (the app model)');
const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is required (the simulated users)');
const judgeKey = process.env.TYPESAFE_API_KEY || undefined;
const repeats = integer('--repeats', 1, 1, 3);
const concurrency = integer('--concurrency', 4, 1, 16);
const maxActions = integer('--max-actions', 16, 1, 40);
const userModel = option('--user-model') ?? process.env.SIM_USER_MODEL ?? 'claude-sonnet-5';

const personas = loadPersonas();
const known = personas.map((persona) => persona.id).join(', ');
const ids = option('--id')?.split(',').map((id) => id.trim()).filter(Boolean) ?? [];
const unknown = ids.filter((id) => !personas.some((persona) => persona.id === id));
if (unknown.length) throw new Error(`Unknown persona: ${unknown.join(', ')}. Known: ${known}`);
const selected = args.includes('--all') ? personas : personas.filter((persona) => ids.includes(persona.id));
if (!selected.length) throw new Error(`Select personas with --all or --id <id>[,<id>] (${known})`);

await mkdir(new URL('./results/', import.meta.url), { recursive: true });
const runId = `sim-${new Date().toISOString().replaceAll(':', '-')}`;
const output = new URL(`./results/${runId}.jsonl`, import.meta.url);
// Rows are large; write them one at a time so concurrent conversations never interleave a line.
let writing = Promise.resolve();
const write = (row: object) => (writing = writing.then(() => appendFile(output, `${JSON.stringify(row)}\n`)));

const jobs = selected.flatMap((persona) => Array.from({ length: repeats }, (_, index) => ({ persona, attempt: index + 1 })));
const rows: SimRow[] = [];
process.stdout.write(`Simulating ${jobs.length} conversation(s): app ${model}, users ${userModel}, judge ${judgeKey ? 'Jev' : 'off'}, concurrency ${concurrency}\n\n`);

async function run({ persona, attempt }: { persona: Persona; attempt: number }) {
  const started = Date.now();
  const user = createClaudeUser({ apiKey: anthropicKey!, model: userModel });
  let row: SimRow & Record<string, unknown>;
  try {
    const trace = await simulate(persona, { user, textModel: model, reasoningEffort: process.env.OPENAI_REASONING_EFFORT, maxActions });
    const invariants = simInvariants(trace);
    const judge = trace.status === 'error' ? null : await judgeConversation({ persona, events: trace.events }, { apiKey: judgeKey });
    row = {
      runId, personaId: persona.id, attempt, model, userModel, promptVersion: trace.promptVersion, fixtureVersion: trace.fixtureVersion,
      status: trace.status, ...(trace.error ? { error: trace.error, errorSource: trace.errorSource } : {}), ...(trace.leave ? { leave: trace.leave } : {}),
      stages: scoreTrace(trace), judge, harnessErrors: trace.steps.filter((step) => step.error).length,
      invariantFailures: invariants.filter((check) => !check.passed).map((check) => check.id), invariants,
      finalProgress: trace.finalProgress, steps: trace.steps, reads: trace.reads, events: trace.events,
      userUsage: user.usage, durationMs: Date.now() - started,
    };
  } catch (error) {
    row = {
      runId, personaId: persona.id, attempt, model, userModel, status: 'error', errorSource: 'harness', error: error instanceof Error ? error.message.slice(0, 300) : 'Unknown error',
      stages: null, judge: null, harnessErrors: 0, invariantFailures: [], durationMs: Date.now() - started,
    };
  }
  const done = rows.push(row);
  process.stdout.write(`[${done}/${jobs.length}] ${persona.id} #${attempt}  ${row.status === 'left' ? `left ${row.leave?.feeling}` : row.status}  (${Math.round(row.durationMs / 1000)}s)\n`);
  await write(row);
}

let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (next < jobs.length) await run(jobs[next++]);
}));
await writing;
const order = new Map(personas.map((persona, index) => [persona.id, index]));
rows.sort((a, b) => (order.get(a.personaId)! - order.get(b.personaId)!) || a.attempt - b.attempt);
process.stdout.write(`\n${rows.map(personaLine).join('\n')}\n\n${summaryLines(rows).join('\n')}\n\nWrote ${fileURLToPath(output)}. Read the transcripts with: bun run eval:sim:show\n`);
// Like eval:app: a failed conversation or a hard invariant failure exits non-zero.
if (rows.some((row) => row.status === 'error' || row.invariantFailures.length)) process.exitCode = 1;
