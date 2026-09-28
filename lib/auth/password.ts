import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Email + password accounts: scrypt with a random 16-byte salt, stored with its parameters as
 * `scrypt$N$r$p$salt$hash` (base64url) so they can be raised later without breaking old hashes.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_BYTES = 32;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Node refuses when 128 * N * r exceeds maxmem; allow exactly what these parameters need.
    const maxmem = 128 * (options.N ?? 0) * (options.r ?? 0) + 2 * 1024 * 1024;
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { ...options, maxmem }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** True when the password matches. A stored value that isn't a sane scrypt hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  const N = Number(n), R = Number(r), P = Number(p);
  if (scheme !== 'scrypt' || !Number.isInteger(Math.log2(N)) || N < 2 ** 14 || N > 2 ** 17 || !Number.isInteger(R) || R < 1 || R > 16 ||
      !Number.isInteger(P) || P < 1 || P > 4 || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  if (expected.length !== KEY_BYTES) return false;
  const actual = await derive(password, Buffer.from(salt, 'base64url'), { N, r: R, p: P });
  return timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;
/** Checks the password against a throwaway hash, so an unknown email takes as long as a wrong password. */
export async function spendPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(12).toString('base64url'));
  await verifyPassword(password, await dummy);
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/;

/** The email, trimmed and lowercased, or undefined when it isn't one. */
export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= 320 && EMAIL.test(email) ? email : undefined;
}

/** A display name as typed: control characters and runs of spaces removed, at most 100 characters. */
export function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, 100) : undefined;
}

/** A keyed hash of an email for per-email rate limits; the address itself is never stored there. */
export function emailLimitKey(email: string, secret = process.env.IP_HASH_SALT || process.env.OPENAI_API_KEY || process.env.DATABASE_URL || 'persona-preview'): string {
  return `email:${createHmac('sha256', secret).update(email).digest('hex').slice(0, 32)}`;
}
