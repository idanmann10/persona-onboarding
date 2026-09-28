import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createPersonaHandler } from '@/lib/http/persona';
import { generateAvatar } from '@/lib/avatars/generate';

export const runtime = 'nodejs';
// Painting a described look can take up to a minute.
export const maxDuration = 90;

export async function POST(request: Request): Promise<Response> {
  try {
    const env = process.env;
    return await createPersonaHandler(createStore(getDatabase()), {
      env,
      ...(env.OPENAI_API_KEY ? { paint: (input: { name: string; description: string }) => generateAvatar(input, { env }) } : {}),
    })(request);
  } catch (error) {
    console.error('Look change failed', error);
    return new Response('That did not go through. Please try again.', { status: 503 });
  }
}
