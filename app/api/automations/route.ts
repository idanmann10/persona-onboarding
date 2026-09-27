import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createAutomationHandler } from '@/lib/http/automations';
import { prepareTurn } from '@/lib/agent/turn';
import { generateTurn, turnDependencies } from '@/lib/agent/runtime';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const store = createStore(getDatabase());
    const configured = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_TEXT_MODEL);
    const deps = turnDependencies(store);
    return await createAutomationHandler(store, configured
      ? async (history, sessionId, trigger) => generateTurn(await prepareTurn(deps, sessionId, history, { turnId: trigger.id, trigger }))
      : undefined)(request);
  } catch (error) {
    console.error('Automation request failed', error);
    return new Response('Automations unavailable', { status: 503 });
  }
}
