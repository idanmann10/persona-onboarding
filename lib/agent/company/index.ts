import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cached: string | undefined;

/**
 * The company memory: what Persona can do today and what's coming soon, one file that every prompt (text
 * and voice) includes whole. Small on purpose, and never trimmed by a prompt budget, so the assistant
 * never offers what isn't real.
 */
export function productMemory(): string {
  if (cached !== undefined) return cached;
  const text = readFileSync(join(process.cwd(), 'lib', 'agent', 'company', 'product.md'), 'utf8').trim();
  // Cached in production; in development an edit shows up on the next turn.
  if (process.env.NODE_ENV === 'production') cached = text;
  return text;
}
