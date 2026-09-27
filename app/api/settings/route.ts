import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createSettingsHandler } from '@/lib/http/settings';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    return await createSettingsHandler(createStore(getDatabase()), process.env)(request);
  } catch (error) {
    console.error('Settings update failed', error);
    return new Response('Settings unavailable', { status: 503 });
  }
}
