import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createDueRunner } from '@/lib/http/automations';
import { prepareTurn } from '@/lib/agent/turn';
import { generateTurn, turnDependencies } from '@/lib/agent/runtime';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Vercel Cron calls GET with `Authorization: Bearer $CRON_SECRET`; without the secret this route is inert. */
export async function GET(request: Request): Promise<Response> {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_TEXT_MODEL) return new Response('Not found', { status: 404 });
  try {
    const store = createStore(getDatabase());
    const deps = turnDependencies(store);
    return await createDueRunner(store, async (history, sessionId, trigger) =>
      generateTurn(await prepareTurn(deps, sessionId, history, { turnId: trigger.id, trigger })), process.env.CRON_SECRET)(request);
  } catch (error) {
    console.error('Due automation run failed', error);
    return new Response('Unavailable', { status: 503 });
  }
}
