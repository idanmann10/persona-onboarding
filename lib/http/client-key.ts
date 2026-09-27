import { createHash } from 'node:crypto';

export type IpScope = 'session' | 'chat' | 'voice' | 'tool' | 'follow_up';

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
};

/** A salted hash of the caller's address; the raw IP is never stored. */
export function clientKey(request: Request, salt = process.env.IP_HASH_SALT || 'persona-preview'): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const address = forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown';
  return createHash('sha256').update(`${salt}:${address}`).digest('hex').slice(0, 32);
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
