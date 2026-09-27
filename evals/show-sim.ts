import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { OnboardingProgress } from '../lib/domain/project';
import type { SimStep } from './sim/run';
import type { SimRow } from './sim/summary';
import { describeAction, valueMention } from './sim/score';

/**
 * Print a simulated-user run as readable transcripts: each action the person took, what the assistant
 * said and which tools ran, how calls ended, and the scores.
 *
 *   bun run eval:sim:show                                the newest sim run
 *   bun run eval:sim:show <file.jsonl>                   a specific run
 *   bun run eval:sim:show --id busy_founder --screens    one persona, with the screen before each action
 */
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const results = new URL('./results/', import.meta.url);
const newest = async () => (await readdir(results).catch(() => [] as string[])).filter((name) => /^sim-.*\.jsonl$/.test(name)).sort().at(-1);
const explicit = args.find((arg) => arg.endsWith('.jsonl'));
const name = explicit ? undefined : await newest();
const file = explicit ?? (name ? fileURLToPath(new URL(name, results)) : undefined);
if (!file) throw new Error('No simulated-user results yet. Run bun run eval:sim first.');

type Row = SimRow & { steps?: SimStep[]; finalProgress?: OnboardingProgress; userUsage?: { inputTokens: number; outputTokens: number } };
const only = option('--id');
const rows = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Row)
  .filter((row) => !only || row.personaId === only);
const oneLine = (text: string, limit = 400) => {
  const flat = text.replace(/\s*\n+\s*/g, ' / ');
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
};
const yes = (value: boolean) => (value ? 'yes' : 'no');

for (const row of rows) {
  const ending = row.status === 'left' ? `left ${row.leave?.feeling}: "${row.leave?.reason}"` : row.status === 'error' ? `ERROR: ${row.error}` : 'ran out of actions';
  console.log(`\n=== ${row.personaId} #${row.attempt} (${Math.round(row.durationMs / 1000)}s)  ${ending}`);
  if (row.stages) {
    const stages = Object.entries(row.stages).filter(([key]) => key !== 'turns').map(([key, value]) => `${key} ${yes(Boolean(value))}`);
    console.log(`    ${stages.join(', ')}, turns ${row.stages.turns}`);
  }
  if (row.judge) console.log(`    judge: form_like ${row.judge.formLike ?? '-'}, pushy ${row.judge.pushy ?? '-'}, ignored_user ${row.judge.ignoredUser ?? '-'}, human ${row.judge.human ?? '-'}/5${row.judge.omittedLines ? ` (${row.judge.omittedLines} lines omitted)` : ''}`);
  if (row.invariantFailures?.length) console.log(`    HARD INVARIANT FAILURES: ${row.invariantFailures.join(', ')}`);
  for (const step of row.steps ?? []) {
    if (args.includes('--screens')) console.log(`\n    ${step.screen.replace(/\n/g, '\n    | ')}`);
    console.log(`  [${step.index + 1}]${step.onCall ? ' (on call)' : ''} ${oneLine(describeAction(step.action), 300)}`);
    if (step.delivered) console.log(`       cut off: the app heard "${step.delivered}"`);
    let ended = false;
    const callEnd = () => {
      if (step.callEnded && !ended) console.log(`       call ended: ${step.callEnded}`);
      ended = true;
    };
    for (const turn of step.turns) {
      if (turn.kind === 'follow_up') callEnd();
      for (const tool of turn.tools) console.log(`       ${tool.name}(${oneLine(JSON.stringify(tool.input) ?? '', 110)})${tool.error ? ` failed: ${tool.error}` : ''}`);
      const label = turn.kind === 'follow_up' ? 'assistant (follow-up)' : turn.channel === 'voice' ? 'assistant (call)' : 'assistant';
      console.log(`       ${label}: ${turn.shown ? oneLine(turn.text) : turn.kind === 'follow_up' ? '(stayed silent)' : '(nothing)'}`);
    }
    callEnd();
    const value = valueMention(step);
    if (value) console.log(`       first value: mentioned "${value}" from an account read`);
    if (step.error) console.log(`       ! ${step.error}`);
    if (step.incomplete) console.log('       ! this step failed; see the error above');
  }
  const progress = row.finalProgress;
  if (progress) console.log(`  state: assistant=${progress.assistantName.value ?? progress.assistantName.status}, user=${progress.preferredName.value ?? progress.preferredName.status}, need=${progress.need.value ? `"${progress.need.value.slice(0, 60)}"` : progress.need.status}, gmail=${progress.gmail}, call=${progress.call}, recurring=${progress.automation.status}`);
  if (row.userUsage) console.log(`  simulated user: ${row.userUsage.inputTokens} input / ${row.userUsage.outputTokens} output tokens`);
}
