/**
 * Paints the default looks (and the default portrait) into public/avatars/<id>.webp, once, live.
 *
 *   bun scripts/generate-avatars.ts            # every look: default + everything in AVATARS
 *   bun scripts/generate-avatars.ts fox sage   # just these
 *
 * Needs OPENAI_API_KEY; OPENAI_IMAGE_MODEL is optional (chatgpt-image-latest, then gpt-image-2).
 * Each portrait is one image request, at high quality since it ships to everyone. Existing files are
 * overwritten. With cwebp installed (brew install webp) each is shrunk to 384 px, enough for the call
 * screen's 188 px portrait on a 2x display; without it the 1024 px original is kept.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AVATARS, DEFAULT_AVATAR, DEFAULT_LOOK } from '../lib/domain/persona';
import { generateAvatar } from '../lib/avatars/generate';

const LOOKS: Record<string, { label: string; description: string }> = { [DEFAULT_AVATAR]: DEFAULT_LOOK, ...AVATARS };
const SIZE = 384;

/** Writes the portrait at SIZE px; false when cwebp isn't available and the original was written instead. */
async function writeSmall(bytes: Uint8Array, target: string): Promise<boolean> {
  const scratch = await mkdtemp(join(tmpdir(), 'persona-avatar-'));
  try {
    const original = join(scratch, 'original.webp');
    await writeFile(original, bytes);
    await promisify(execFile)('cwebp', ['-quiet', '-q', '82', '-m', '6', '-resize', String(SIZE), String(SIZE), original, '-o', target]);
    return true;
  } catch {
    await writeFile(target, bytes);
    return false;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((id) => !Object.hasOwn(LOOKS, id));
  if (unknown.length) throw new Error(`Unknown look: ${unknown.join(', ')}. Choose from ${Object.keys(LOOKS).join(', ')}.`);
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY first.');
  const directory = new URL('../public/avatars/', import.meta.url);
  await mkdir(directory, { recursive: true });
  let failures = 0;
  for (const id of wanted.length ? wanted : Object.keys(LOOKS)) {
    const look = LOOKS[id];
    const result = await generateAvatar({ name: look.label, description: look.description }, { quality: 'high', timeoutMs: 180_000 });
    if (!result.ok) { failures++; console.error(`${id}: ${result.error}${result.status ? ` (HTTP ${result.status})` : ''}: ${result.message}`); continue; }
    if (result.mime !== 'image/webp') { failures++; console.error(`${id}: ${result.model} returned ${result.mime}, not webp; use a gpt-image model.`); continue; }
    const target = fileURLToPath(new URL(`${id}.webp`, directory));
    const small = await writeSmall(result.bytes, target);
    console.log(`${id}: public/avatars/${id}.webp (${small ? `${SIZE} px` : '1024 px, cwebp not found'}, ${result.model})`);
  }
  if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
