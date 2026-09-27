import { createStore } from '../lib/db/store';
import { getDatabase } from '../lib/db/client';
import { summarizeFunnel } from '../lib/domain/funnel';

/**
 * Print the onboarding funnel over the most recent sessions in DATABASE_URL.
 *
 *   bun run funnel [--limit 500] [--json]
 */
const args = process.argv.slice(2);
const limitIndex = args.indexOf('--limit');
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 500;
const sql = getDatabase();
try {
  const summary = summarizeFunnel((await createStore(sql).recentSessions(limit)).map((session) => session.events));
  if (args.includes('--json')) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`Sessions: ${summary.sessions}`);
    for (const stage of summary.stages) console.log(`${String(stage.percent).padStart(5)}%  ${String(stage.count).padStart(5)}  ${stage.label}`);
  }
} finally {
  await sql.end();
}
