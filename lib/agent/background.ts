import { after } from 'next/server';
import { createStore } from '../db/store';
import { getDatabase } from '../db/client';
import { signedInSession } from '../auth/login';
import { turnDependencies } from './runtime';
import { reconcile } from './follow-ups';

/**
 * For routes: once this response is sent (Next's `after`), let the assistant (woken by what happened) and the memory settle
 * whatever the request just recorded (a call ended, an account connected, a task ran). It never delays or
 * fails the response, and running it twice is harmless: each trigger is decided once.
 */
export function settleAfter(sessionId: string | undefined): void {
  if (!sessionId || !process.env.OPENAI_API_KEY || !process.env.OPENAI_TEXT_MODEL) return;
  after(async () => {
    try { await reconcile(turnDependencies(createStore(getDatabase())), sessionId); }
    catch (error) { console.error('Follow-ups failed', error); }
  });
}

/** The same, for the signed-in user's conversation behind this request. */
export async function settleAfterRequest(request: Request): Promise<void> {
  try { settleAfter(await signedInSession(createStore(getDatabase()), request)); }
  catch (error) { console.error('Follow-ups not scheduled', error); }
}
