import { createHmac } from 'node:crypto';

export type IpScope = 'session' | 'chat' | 'voice' | 'tool' | 'follow_up' | 'voice_event';

/**
 * Per-client limits across all guest sessions, so churning cookies cannot mint unlimited sessions or
 * billed calls. [limit, window seconds]; generous enough for real use from a shared office network.
 */
export const IP_LIMITS: Record<IpScope, [number, number]> = {
  session: [30, 3_600],
  chat: [240, 3_600],
  voice: [12, 3_600],
  tool: [300, 3_600],
  follow_up: [60, 3_600],
  // Every call the voice limit allows, at full length: 12 calls x 12 min x ~90 posts a minute
  // (transcript batches every 700 ms while someone talks, plus typed text and phase changes).
  voice_event: [15_000, 3_600],
};

/**
 * The caller's address, as set by the platform: Vercel's own header first, then the right-most
 * X-Forwarded-For entry (appended by the nearest proxy; left-most entries are caller-controlled),
 * then X-Real-IP.
 */
export function clientAddress(request: Request): string {
  const vercel = request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').map((part) => part.trim()).filter(Boolean).at(-1);
  return vercel || forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * A keyed hash of the caller's address; the raw IP is never stored. The key is IP_HASH_SALT, or else a
 * server secret, so a stored hash cannot be brute-forced back to an IPv4 address from public code.
 */
export function clientKey(request: Request, secret = process.env.IP_HASH_SALT || process.env.OPENAI_API_KEY || process.env.DATABASE_URL || 'persona-preview'): string {
  return createHmac('sha256', secret).update(clientAddress(request)).digest('hex').slice(0, 32);
}

export interface IpQuotaStore {
  consumeIpQuota?(key: string, scope: IpScope, limit: number, windowSeconds: number): Promise<boolean>;
}

/** True when the request may proceed. Stores without IP limits (unit-test stubs) always allow. */
export async function withinIpLimit(store: IpQuotaStore, request: Request, scope: IpScope): Promise<boolean> {
  if (!store.consumeIpQuota) return true;
  const [limit, window] = IP_LIMITS[scope];
  return store.consumeIpQuota(clientKey(request), scope, limit, window);
}
