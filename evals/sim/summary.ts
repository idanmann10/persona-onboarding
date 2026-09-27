import type { SimJudgment } from './judge';
import type { SimStages } from './score';
import type { SimStatus } from './run';

/** The summary fields of one JSONL row written by `bun run eval:sim`. */
export interface SimRow {
  personaId: string;
  attempt: number;
  status: SimStatus;
  error?: string;
  /** Which side failed: the app (its model turns and endpoints), the simulated user, or the harness. */
  errorSource?: 'app' | 'user' | 'harness';
  leave?: { feeling: string; reason: string };
  stages: SimStages | null;
  judge: SimJudgment | null;
  /** Actions the harness could not apply, such as a tap on a button that was not on screen. */
  harnessErrors: number;
  /** Failed hard invariants (see evals/sim/score.ts simInvariants). */
  invariantFailures: string[];
  durationMs: number;
}

type Stage = Exclude<keyof SimStages, 'turns'>;

const yesNo = (value: boolean | undefined) => (value ? 'yes' : 'no ');
const fixed = (value: number | null | undefined, digits = 2) => (typeof value === 'number' ? value.toFixed(digits) : '-');
/** A failure on the simulated user's side, or the harness's, says nothing about the app. */
const outsideTheApp = (row: SimRow) => row.status === 'error' && (row.errorSource === 'user' || row.errorSource === 'harness');

export function personaLine(row: SimRow): string {
  const ending = row.status === 'left' ? `left ${row.leave?.feeling ?? ''}` : row.status === 'error' ? `ERROR ${row.errorSource ?? ''}`.trim() : 'out of actions';
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

/**
 * Totals over the conversations that say something about the app: a conversation that failed because
 * the simulated user (or the harness) did is left out of the rates and counted on its own line. An app
 * failure stays in: the person did not get what they came for.
 */
export function summaryLines(rows: SimRow[]): string[] {
  const counted = rows.filter((row) => !outsideTheApp(row));
  const total = counted.length;
  const percent = (count: number) => (total ? `${Math.round((count / total) * 100)}%` : '-');
  const rate = (stage: Stage) => {
    const count = counted.filter((row) => row.stages?.[stage] === true).length;
    return `  ${stage.padEnd(18)}${String(count).padStart(3)}/${total}  ${percent(count)}`;
  };
  const mean = (values: Array<number | null | undefined>) => {
    const known = values.filter((value): value is number => typeof value === 'number');
    return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
  };
  const judged = counted.filter((row) => row.judge);
  const turns = mean(counted.map((row) => row.stages?.turns));
  const leftOut = rows.length - total;
  return [
    `Conversations: ${rows.length}${leftOut ? ` (${leftOut} left out of the rates: the simulated user or the harness failed)` : ''}${turns === null ? '' : `, mean ${turns.toFixed(1)} actions each`}`,
    ...(['stayed', 'activated', 'briefComplete', 'firstValue', 'gmailConnected', 'callHappened'] as const).map(rate),
    judged.length
      ? `Judge (n=${judged.length}): form_like ${fixed(mean(judged.map((row) => row.judge!.formLike)))}  pushy ${fixed(mean(judged.map((row) => row.judge!.pushy)))}  ignored_user ${fixed(mean(judged.map((row) => row.judge!.ignoredUser)))}  human ${fixed(mean(judged.map((row) => row.judge!.human)))}/5`
      : 'Judge: none (no TYPESAFE_API_KEY, or every request failed)',
    `Errors: ${rows.filter((row) => row.status === 'error' && !outsideTheApp(row)).length} app failure(s), ${leftOut} simulated-user or harness failure(s); ${rows.reduce((sum, row) => sum + row.harnessErrors, 0)} action(s) not applied; ${rows.reduce((sum, row) => sum + row.invariantFailures.length, 0)} hard invariant failure(s)`,
  ];
}
