/**
 * Paints the default looks (and the default portrait) into public/avatars/<id>.webp, once, live.
 *
 *   bun scripts/generate-avatars.ts            # all seven: default + the six looks
 *   bun scripts/generate-avatars.ts fox sage   # just these
 *
 * Needs OPENAI_API_KEY; OPENAI_IMAGE_MODEL is optional (chatgpt-image-latest, then gpt-image-2).
 * Each portrait is one image request. Existing files are overwritten.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { AVATARS, DEFAULT_AVATAR, DEFAULT_LOOK } from '../lib/domain/persona';
import { generateAvatar } from '../lib/avatars/generate';

const LOOKS: Record<string, { label: string; description: string }> = { [DEFAULT_AVATAR]: DEFAULT_LOOK, ...AVATARS };

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
    const result = await generateAvatar({ name: look.label, description: look.description });
    if (!result.ok) { failures++; console.error(`${id}: ${result.error}${result.status ? ` (HTTP ${result.status})` : ''}: ${result.message}`); continue; }
    if (result.mime !== 'image/webp') { failures++; console.error(`${id}: ${result.model} returned ${result.mime}, not webp; use a gpt-image model.`); continue; }
    await writeFile(new URL(`${id}.webp`, directory), result.bytes);
    console.log(`${id}: public/avatars/${id}.webp (${Math.round(result.bytes.byteLength / 1024)} KB, ${result.model})`);
  }
  if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
