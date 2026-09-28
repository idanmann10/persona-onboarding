/**
 * Writes lib/integrations/apps-snapshot.json: every Composio app a user can connect with Composio's own
 * sign-in (about 120), with its name, logo and category. The Apps sheet renders from this file, so it
 * opens without waiting for Composio's full toolkit catalog, which each serverless cold start would
 * otherwise page through again. Apps added after the snapshot are still found by the sheet's server search.
 *
 * Run it now and then: `bun scripts/snapshot-apps.ts` (reads COMPOSIO_API_KEY from .env.local).
 */
import { writeFile } from 'node:fs/promises';
import { createToolkitCatalog } from '../lib/integrations/catalog';

const key = process.env.COMPOSIO_API_KEY;
if (!key) throw new Error('COMPOSIO_API_KEY is required');

const apps = (await createToolkitCatalog(key).list())
  // Toolkits that need no sign-in have nothing to connect, so the sheet does not list them.
  .filter((app) => !app.noAuth)
  .map(({ slug, name, logo, category }) => ({ slug, name, ...(logo ? { logo } : {}), ...(category ? { category } : {}) }))
  .sort((a, b) => a.slug.localeCompare(b.slug));
for (const required of ['gmail', 'calendar']) {
  if (!apps.some((app) => app.slug === required)) throw new Error(`The catalog came back without ${required}; not writing a partial snapshot`);
}

// One app per line keeps a refreshed snapshot's diff readable.
const body = `{\n "generatedAt": ${JSON.stringify(new Date().toISOString())},\n "apps": [\n${apps.map((app) => `  ${JSON.stringify(app)}`).join(',\n')}\n ]\n}\n`;
await writeFile(new URL('../lib/integrations/apps-snapshot.json', import.meta.url), body);
console.log(`Wrote ${apps.length} apps to lib/integrations/apps-snapshot.json`);
