import { appendFile, mkdir } from 'node:fs/promises';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import cases from './cases/base.json';
import { selectScenarios } from './select';
import { buildSystemPrompt, PROMPT_VERSION } from '../lib/agent/prompts';

const args = process.argv.slice(2);
const selected = selectScenarios(cases, args);
const repeatIndex = args.indexOf('--repeats');
const repeats = repeatIndex >= 0 ? Number(args[repeatIndex + 1]) : args.includes('--all') ? 3 : 1;
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('--repeats must be 1–5');
const model = process.env.OPENAI_TEXT_MODEL;
if (!process.env.OPENAI_API_KEY || !model) throw new Error('OPENAI_API_KEY and OPENAI_TEXT_MODEL are required');
await mkdir(new URL('./results/', import.meta.url), { recursive: true });
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID().slice(0, 8)}`;
const output = new URL(`./results/${runId}.jsonl`, import.meta.url);

for (const scenario of selected) {
  const userText = scenario.turns.filter((turn) => turn.actor === 'user').map((turn) => turn.content).join('\n');
  for (let attempt = 1; attempt <= repeats; attempt++) {
    const started = Date.now();
    const base = { runId, caseId: scenario.id, group: scenario.group, attempt, model, promptVersion: PROMPT_VERSION,
      expected: scenario.expected, critical: scenario.critical, mode: 'prompt_only', scored: false };
    try {
      const result = await generateText({ model: openai(model), system: buildSystemPrompt({ facts: [], capabilities: ['text'] }),
        prompt: userText });
      await appendFile(output, JSON.stringify({ ...base, response: result.text, durationMs: Date.now() - started, status: 'completed' }) + '\n');
    } catch (error) {
      await appendFile(output, JSON.stringify({ ...base, durationMs: Date.now() - started, status: 'error', error: error instanceof Error ? error.message.slice(0, 300) : 'Unknown error' }) + '\n');
    }
  }
}
process.stdout.write(`Wrote ${selected.length * repeats} unscored prompt traces to ${output.pathname}\n`);
