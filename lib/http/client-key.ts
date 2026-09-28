import { createHmac } from 'node:crypto';

export type IpScope = 'session' | 'chat' | 'voice' | 'tool' | 'follow_up' | 'voice_event' | 'sign_in' | 'sign_up' | 'sign_in_email' | 'look' | 'paint';

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
  // Email + password: attempts per network, new accounts per network, and attempts per email (keyed by
  // a hash of the address instead of the network; see lib/auth/password.ts).
  sign_in: [30, 900],
  sign_up: [10, 3_600],
  sign_in_email: [10, 900],
  // The look picker: picking a stock portrait is cheap; painting a described one is a billed image.
  look: [120, 3_600],
  paint: [12, 3_600],
};

/**
 * The caller's address, as set by the platform: Vercel's own header first (only on Vercel, which
 * overwrites it; anywhere else a caller could send it), then the right-most X-Forwarded-For entry
 * (appended by the nearest proxy, e.g. Railway's; left-most entries are caller-controlled), then X-Real-IP.
 */
export function clientAddress(request: Request): string {
  const vercel = process.env.VERCEL ? request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() : undefined;
  const chain = request.headers.get('x-forwarded-for')?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
  // Through the Vercel front door, the right-most entry is Vercel's own address (every user would share one
  // limit); the one before it is the visitor, as Vercel saw them. A caller who skips the front door and
  // fakes this can only dodge the per-network limits; per-conversation and per-email limits still apply.
  const forwarded = viaFrontDoor(request) && chain.length >= 2 ? chain.at(-2) : chain.at(-1);
  return vercel || forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/** The request came through the app's public address (Vercel passing it on), not straight to this server. */
function viaFrontDoor(request: Request): boolean {
  if (process.env.VERCEL || !request.headers.get('x-vercel-id')) return false;
  try { return Boolean(process.env.APP_BASE_URL) && new URL(process.env.APP_BASE_URL!).host !== new URL(request.url).host; }
  catch { return false; }
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
