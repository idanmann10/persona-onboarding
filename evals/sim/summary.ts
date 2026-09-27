import type { SimJudgment } from './judge';
import type { SimStages } from './score';
import type { SimStatus } from './run';

/** The summary fields of one JSONL row written by `bun run eval:sim`. */
export interface SimRow {
  personaId: string;
  attempt: number;
  status: SimStatus;
  error?: string;
  leave?: { feeling: string; reason: string };
  stages: SimStages | null;
  judge: SimJudgment | null;
  /** Steps the harness could not apply, such as a tap on a button that was not on screen. */
  harnessErrors: number;
  /** Failed hard invariants (see evals/app/invariants.ts). */
  invariantFailures: string[];
  durationMs: number;
}

type Stage = Exclude<keyof SimStages, 'turns'>;

const yesNo = (value: boolean | undefined) => (value ? 'yes' : 'no ');
const fixed = (value: number | null | undefined, digits = 2) => (typeof value === 'number' ? value.toFixed(digits) : '-');

export function personaLine(row: SimRow): string {
  const ending = row.status === 'left' ? `left ${row.leave?.feeling ?? ''}` : row.status === 'error' ? 'ERROR' : 'out of actions';
  const parts = [`${row.personaId} #${row.attempt}`.padEnd(25), ending.padEnd(15)];
  if (row.stages) {
    const { stayed, activated, briefComplete, turns } = row.stages;
    parts.push(`stayed ${yesNo(stayed)}  activated ${yesNo(activated)}  brief ${yesNo(briefComplete)}  turns ${String(turns).padStart(2)}`);
  }
  if (row.judge) parts.push(`form ${fixed(row.judge.formLike)} pushy ${fixed(row.judge.pushy)} ignored ${fixed(row.judge.ignoredUser)} human ${fixed(row.judge.human, 1)}`);
  if (row.invariantFailures.length) parts.push(`HARD: ${row.invariantFailures.join(', ')}`);
  if (row.status === 'error' && row.error) parts.push(row.error.slice(0, 120));
  return parts.join('  ').trimEnd();
}

export function summaryLines(rows: SimRow[]): string[] {
  const total = rows.length;
  const percent = (count: number) => (total ? `${Math.round((count / total) * 100)}%` : '-');
  const rate = (stage: Stage) => {
    const count = rows.filter((row) => row.stages?.[stage] === true).length;
    return `  ${stage.padEnd(18)}${String(count).padStart(3)}/${total}  ${percent(count)}`;
  };
  const mean = (values: Array<number | null | undefined>) => {
    const known = values.filter((value): value is number => typeof value === 'number');
    return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
  };
  const judged = rows.filter((row) => row.judge);
  const turns = mean(rows.map((row) => row.stages?.turns));
  return [
    `Conversations: ${total}${turns === null ? '' : `, mean ${turns.toFixed(1)} actions each`}`,
    ...(['stayed', 'activated', 'briefComplete', 'firstValue', 'gmailConnected', 'callHappened'] as const).map(rate),
    judged.length
      ? `Judge (n=${judged.length}): form_like ${fixed(mean(judged.map((row) => row.judge!.formLike)))}  pushy ${fixed(mean(judged.map((row) => row.judge!.pushy)))}  ignored_user ${fixed(mean(judged.map((row) => row.judge!.ignoredUser)))}  human ${fixed(mean(judged.map((row) => row.judge!.human)))}/5`
      : 'Judge: none (no TYPESAFE_API_KEY, or every request failed)',
    `Errors: ${rows.filter((row) => row.status === 'error').length} conversation(s) failed; ${rows.reduce((sum, row) => sum + row.harnessErrors, 0)} harness error(s); ${rows.reduce((sum, row) => sum + row.invariantFailures.length, 0)} hard invariant failure(s)`,
  ];
}
