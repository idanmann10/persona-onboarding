import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createAvatarHandler } from '@/lib/avatars/route';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    return await createAvatarHandler(createStore(getDatabase()))(request, id);
  } catch (error) {
    console.error('Avatar request failed', error);
    return new Response('Avatar service unavailable', { status: 503 });
  }
}
