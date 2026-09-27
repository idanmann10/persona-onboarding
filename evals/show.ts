import { readdir, readFile } from 'node:fs/promises';

/**
 * Print an eval run as readable transcripts: what the user did, which tools ran, what the assistant
 * said, and which checks failed.
 *
 *   bun run eval:show              the newest run
 *   bun run eval:show <file.jsonl> a specific run
 */
const results = new URL('./results/', import.meta.url);
const file = process.argv[2] ?? (await readdir(results)).filter((name) => name.endsWith('.jsonl')).sort().map((name) => new URL(name, results).pathname).at(-1);
if (!file) throw new Error('No eval results yet. Run bun run eval:app first.');

interface Check { id: string; passed: boolean; detail?: string }
interface Row {
  scenarioId: string; attempt: number; status?: string; error?: string; durationMs: number;
  invariants?: Check[]; expectations?: Check[];
  steps?: Array<{ kind: string; input: string; output: string | null; followUp?: string; tools: Array<{ name: string; input: unknown }> }>;
  finalProgress?: { assistantName: { status: string; value?: string }; preferredName: { status: string; value?: string }; need: { value?: string }; gmail: string; call: string; automation: { status: string } };
}

const rows = (await readFile(decodeURIComponent(file.replace(/^\/(\w:)/, '$1')), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Row);
for (const row of rows) {
  const title = `${row.scenarioId} #${row.attempt} (${Math.round(row.durationMs / 1000)}s)`;
  if (row.status === 'error') { console.log(`\n=== ${title}  ERROR: ${row.error}`); continue; }
  const failed = [...(row.invariants ?? []), ...(row.expectations ?? [])].filter((check) => !check.passed);
  console.log(`\n=== ${title}  ${failed.length ? `FAILED: ${failed.map((check) => check.id).join(', ')}` : 'all checks passed'}`);
  for (const step of row.steps ?? []) {
    console.log(`  [${step.kind}] ${step.input.replace(/\n/g, ' | ')}`);
    for (const tool of step.tools) console.log(`     ${tool.name}(${JSON.stringify(tool.input).slice(0, 110)})`);
    console.log(`     -> ${step.followUp === 'silent' ? '(stayed silent)' : (step.output ?? '(nothing)').replace(/\n+/g, ' / ')}`);
  }
  const progress = row.finalProgress;
  if (progress) console.log(`  state: assistant=${progress.assistantName.value ?? progress.assistantName.status}, user=${progress.preferredName.value ?? progress.preferredName.status}, need=${progress.need.value ? `"${progress.need.value.slice(0, 50)}"` : 'unknown'}, gmail=${progress.gmail}, call=${progress.call}, recurring=${progress.automation.status}`);
}
