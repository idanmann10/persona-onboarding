import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createDueRunner } from '@/lib/http/automations';
import { prepareTurn } from '@/lib/agent/turn';
import { generateTurn, turnDependencies } from '@/lib/agent/runtime';
import { reconcile } from '@/lib/agent/follow-ups';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Vercel Cron calls GET with `Authorization: Bearer $CRON_SECRET`; without the secret this route is inert.
 * It runs due recurring tasks, then check-ins the onboarding coach scheduled for people who aren't here.
 */
export async function GET(request: Request): Promise<Response> {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_TEXT_MODEL) return new Response('Not found', { status: 404 });
  try {
    const store = createStore(getDatabase());
    const deps = turnDependencies(store);
    const response = await createDueRunner(store, async (history, sessionId, trigger) =>
      generateTurn(await prepareTurn(deps, sessionId, history, { turnId: trigger.id, trigger })), process.env.CRON_SECRET)(request);
    if (!response.ok) return response;
    let checkIns = 0;
    for (const sessionId of await store.sessionsWithDueCheckIns()) {
      try { checkIns += (await reconcile(deps, sessionId)).filter((result) => result.messaged).length; }
      catch (error) { console.error('Scheduled check-in failed', error); }
    }
    return Response.json({ ...(await response.json() as Record<string, unknown>), checkIns });
  } catch (error) {
    console.error('Due automation run failed', error);
    return new Response('Unavailable', { status: 503 });
  }
}
